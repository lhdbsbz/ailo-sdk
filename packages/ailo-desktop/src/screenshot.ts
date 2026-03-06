import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";
import type { CoordinateSpace, DesktopObservation, DesktopScope, Rect } from "./desktop_types.js";

interface ScreenDescriptor extends Rect {
  index: number;
  primary: boolean;
}

export interface ScreenInfo {
  count: number;
  screens: ScreenDescriptor[];
  virtualBounds: Rect;
}

export interface ScreenshotOptions {
  capture_window?: boolean;
  /** 多显示器时：不传或 "all" 截取全部，0/1/2... 截取指定显示器（0-based）*/
  screen?: number | "all";
}

export interface ScreenshotCaptureResult {
  parts: ContentPart[];
  observation?: DesktopObservation;
}

function ok(message: string, observation: DesktopObservation): ContentPart[] {
  return [
    {
      type: "text",
      text: JSON.stringify({
        ok: true,
        message,
        observation: {
          observation_id: observation.id,
          timestamp: observation.timestamp,
          scope: observation.scope,
          coordinate_space: observation.coordinateSpace,
          image_width: observation.imageWidth,
          image_height: observation.imageHeight,
          image_path: observation.image.path,
        },
      }, null, 2),
    },
    {
      type: "image",
      media: {
        type: "image",
        path: observation.image.path,
        mime: observation.image.mime,
        name: observation.image.name,
      },
    },
  ];
}

function fail(error: string): ScreenshotCaptureResult {
  return {
    parts: [{ type: "text", text: JSON.stringify({ ok: false, error }, null, 2) }],
  };
}

export function getScreenInfo(): ScreenInfo {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$screens=[System.Windows.Forms.Screen]::AllScreens",
      "$primary=[System.Windows.Forms.Screen]::PrimaryScreen",
      "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen",
      "$r=@()",
      "for($i=0;$i -lt $screens.Count;$i++){",
      "  $b=$screens[$i].Bounds",
      "  $r+=@{index=$i;x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height;primary=($screens[$i] -eq $primary)}",
      "}",
      "Write-Output (@{count=$screens.Count;screens=$r;virtualBounds=@{x=$vs.X;y=$vs.Y;width=$vs.Width;height=$vs.Height}}|ConvertTo-Json -Compress)",
    ].join("; ");
    const r = spawnSync("powershell", ["-Command", ps], { encoding: "utf-8", timeout: 5000 });
    try {
      const j = JSON.parse((r.stdout ?? "").trim());
      return {
        count: j.count ?? 1,
        screens: (j.screens ?? []).map((s: any) => ({
          index: s.index,
          x: s.x ?? 0,
          y: s.y ?? 0,
          width: s.width,
          height: s.height,
          primary: !!s.primary,
        })),
        virtualBounds: {
          x: j.virtualBounds?.x ?? 0,
          y: j.virtualBounds?.y ?? 0,
          width: j.virtualBounds?.width ?? 1920,
          height: j.virtualBounds?.height ?? 1080,
        },
      };
    } catch {
      return {
        count: 1,
        screens: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true }],
        virtualBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      };
    }
  } else if (platform === "darwin") {
    const r = spawnSync("system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf-8", timeout: 5000 });
    try {
      const j = JSON.parse((r.stdout ?? "").trim());
      const displays = (j?.SPDisplaysDataType ?? []).flatMap((d: any) => d.spdisplays_ndrvs ?? [d]);
      const screens = displays
        .filter((d: any) => d.spdisplays_resolution)
        .map((d: any, i: number) => {
          const m = String(d.spdisplays_resolution ?? "").match(/(\d+)\s*x\s*(\d+)/);
          return {
            index: i,
            x: 0,
            y: 0,
            width: m ? Number(m[1]) : 1920,
            height: m ? Number(m[2]) : 1080,
            primary: i === 0,
          };
        });
      const primary = screens[0] ?? { index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true };
      return { count: screens.length || 1, screens: screens.length ? screens : [primary], virtualBounds: { x: 0, y: 0, width: primary.width, height: primary.height } };
    } catch {
      return {
        count: 1,
        screens: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true }],
        virtualBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      };
    }
  } else {
    const r = spawnSync("xdpyinfo", [], { encoding: "utf-8", timeout: 5000 });
    const m = (r.stdout ?? "").match(/dimensions:\s*(\d+)x(\d+)/);
    const width = m ? Number(m[1]) : 1920;
    const height = m ? Number(m[2]) : 1080;
    return {
      count: 1,
      screens: [{ index: 0, x: 0, y: 0, width, height, primary: true }],
      virtualBounds: { x: 0, y: 0, width, height },
    };
  }
}

function buildObservation(args: {
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  captureWindow: boolean;
  screenOpt?: number | "all";
}): DesktopObservation {
  const { imagePath, imageWidth, imageHeight, captureWindow, screenOpt } = args;
  const screenInfo = getScreenInfo();
  let scope: DesktopScope;
  let coordinateSpace: CoordinateSpace;

  if (captureWindow) {
    scope = {
      kind: "window",
      bounds: { x: 0, y: 0, width: imageWidth, height: imageHeight },
    };
    coordinateSpace = "window_local";
  } else if (typeof screenOpt === "number") {
    const screen = screenInfo.screens.find((item) => item.index === screenOpt) ?? screenInfo.screens[0];
    scope = {
      kind: "screen",
      screenIndex: screen.index,
      bounds: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
    };
    coordinateSpace = "screen_local";
  } else {
    scope = {
      kind: "virtual_screen",
      bounds: screenInfo.virtualBounds,
    };
    coordinateSpace = "virtual_screen";
  }

  return {
    id: `obs_${randomUUID()}`,
    timestamp: Date.now(),
    scope,
    coordinateSpace,
    imageWidth,
    imageHeight,
    image: {
      path: imagePath,
      mime: "image/png",
      name: "screenshot.png",
    },
  };
}

export async function captureDesktopObservation(opts: ScreenshotOptions | boolean = false): Promise<ScreenshotCaptureResult> {
  const captureWindow = typeof opts === "boolean" ? opts : !!opts.capture_window;
  const screenOpt = typeof opts === "boolean" ? undefined : opts?.screen;
  const tmpPath = path.join(os.tmpdir(), `ailo_screenshot_${Date.now()}.png`);
  const platform = os.platform();

  if (platform === "darwin") {
    if (captureWindow) {
      spawnSync("screencapture", ["-w", tmpPath]);
    } else if (typeof screenOpt === "number") {
      spawnSync("screencapture", ["-x", "-D", String(screenOpt + 1), tmpPath]);
    } else {
      spawnSync("screencapture", ["-x", tmpPath]);
    }
  } else if (platform === "win32") {
    const escaped = tmpPath.replace(/'/g, "''").replace(/\\/g, "\\\\");
    let ps: string;
    if (typeof screenOpt === "number") {
      ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$screens=[System.Windows.Forms.Screen]::AllScreens",
        `$idx=${screenOpt}`,
        "if($idx -ge $screens.Count){ $idx=0 }",
        "$screen=$screens[$idx].Bounds",
        "$bmp=New-Object System.Drawing.Bitmap($screen.Width,$screen.Height)",
        "$g=[System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($screen.Location,[System.Drawing.Point]::Empty,$screen.Size)",
        `$bmp.Save('${escaped}')`,
      ].join("; ");
    } else {
      ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen",
        "$bmp=New-Object System.Drawing.Bitmap($vs.Width,$vs.Height)",
        "$g=[System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($vs.X,$vs.Y,0,0,[System.Drawing.Size]::new($vs.Width,$vs.Height))",
        `$bmp.Save('${escaped}')`,
      ].join("; ");
    }
    spawnSync("powershell", ["-Command", ps]);
  } else {
    const r = spawnSync("scrot", [tmpPath]);
    if (r.status !== 0) spawnSync("import", ["-window", "root", tmpPath]);
  }

  if (!fs.existsSync(tmpPath)) return fail("截图失败：未能生成截图文件");

  let imageWidth = 0;
  let imageHeight = 0;
  try {
    const screenInfo = getScreenInfo();
    if (typeof screenOpt === "number") {
      const screen = screenInfo.screens.find((item) => item.index === screenOpt) ?? screenInfo.screens[0];
      imageWidth = screen.width;
      imageHeight = screen.height;
    } else {
      imageWidth = screenInfo.virtualBounds.width;
      imageHeight = screenInfo.virtualBounds.height;
    }
  } catch {
    imageWidth = 1920;
    imageHeight = 1080;
  }

  const observation = buildObservation({
    imagePath: tmpPath,
    imageWidth,
    imageHeight,
    captureWindow,
    screenOpt,
  });

  let message: string;
  if (captureWindow) {
    message = "窗口截图完成";
  } else {
    const screenInfo = getScreenInfo();
    if (screenInfo.count > 1) {
      if (typeof screenOpt === "number") {
        message = `截图完成（第 ${screenOpt + 1} 块/共 ${screenInfo.count} 块屏。可用 screen=0～${screenInfo.count - 1} 分别截取其他屏）`;
      } else {
        message = `截图完成（共 ${screenInfo.count} 块屏，已截取全部。可用 screen=0～${screenInfo.count - 1} 分别截取单块）`;
      }
    } else {
      message = typeof screenOpt === "number" ? `显示器 ${screenOpt} 截图完成` : "截图完成";
    }
  }

  return {
    parts: ok(message, observation),
    observation,
  };
}

export async function takeScreenshot(opts: ScreenshotOptions | boolean = false): Promise<ContentPart[]> {
  const result = await captureDesktopObservation(opts);
  return result.parts;
}
