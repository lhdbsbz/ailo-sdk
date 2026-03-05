import { spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";

export interface ScreenInfo {
  count: number;
  screens: { index: number; width: number; height: number; primary: boolean }[];
}

export function getScreenInfo(): ScreenInfo {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$screens=[System.Windows.Forms.Screen]::AllScreens",
      "$primary=[System.Windows.Forms.Screen]::PrimaryScreen",
      "$r=@()",
      "for($i=0;$i -lt $screens.Count;$i++){",
      "  $b=$screens[$i].Bounds",
      "  $r+=@{index=$i;width=$b.Width;height=$b.Height;primary=($screens[$i] -eq $primary)}",
      "}",
      "Write-Output (@{count=$screens.Count;screens=$r}|ConvertTo-Json -Compress)",
    ].join("; ");
    const r = spawnSync("powershell", ["-Command", ps], { encoding: "utf-8", timeout: 5000 });
    try {
      const j = JSON.parse((r.stdout ?? "").trim());
      return { count: j.count ?? 1, screens: (j.screens ?? []).map((s: any) => ({ index: s.index, width: s.width, height: s.height, primary: !!s.primary })) };
    } catch {
      return { count: 1, screens: [{ index: 0, width: 1920, height: 1080, primary: true }] };
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
          return { index: i, width: m ? Number(m[1]) : 1920, height: m ? Number(m[2]) : 1080, primary: i === 0 };
        });
      return { count: screens.length || 1, screens: screens.length ? screens : [{ index: 0, width: 1920, height: 1080, primary: true }] };
    } catch {
      return { count: 1, screens: [{ index: 0, width: 1920, height: 1080, primary: true }] };
    }
  } else {
    const r = spawnSync("xdpyinfo", [], { encoding: "utf-8", timeout: 5000 });
    const m = (r.stdout ?? "").match(/dimensions:\s*(\d+)x(\d+)/);
    const w = m ? Number(m[1]) : 1920;
    const h = m ? Number(m[2]) : 1080;
    return { count: 1, screens: [{ index: 0, width: w, height: h, primary: true }] };
  }
}

export interface ScreenshotOptions {
  capture_window?: boolean;
  /** 多显示器时：不传或 "all" 截取全部，0/1/2... 截取指定显示器（0-based）*/
  screen?: number | "all";
}

export async function takeScreenshot(opts: ScreenshotOptions | boolean = false): Promise<ContentPart[]> {
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
    if (r.status !== 0) {
      spawnSync("import", ["-window", "root", tmpPath]);
    }
  }

  if (!fs.existsSync(tmpPath)) {
    return [{ type: "text", text: "截图失败：未能生成截图文件" }];
  }

  const info = getScreenInfo();
  let msg: string;
  if (captureWindow) {
    msg = "窗口截图完成";
  } else if (info.count > 1) {
    if (typeof screenOpt === "number") {
      msg = `截图完成（第 ${screenOpt + 1} 块/共 ${info.count} 块屏。可用 screen=0～${info.count - 1} 分别截取其他屏）`;
    } else {
      msg = `截图完成（共 ${info.count} 块屏，已截取全部。可用 screen=0～${info.count - 1} 分别截取单块）`;
    }
  } else {
    msg = typeof screenOpt === "number" ? `显示器 ${screenOpt} 截图完成` : "截图完成";
  }

  return [
    { type: "text", text: msg },
    {
      type: "image",
      media: { type: "image", path: tmpPath, mime: "image/png", name: "screenshot.png" },
    },
  ];
}
