import { execSync, spawnSync } from "child_process";
import * as os from "os";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";
import { takeScreenshot } from "./screenshot.js";

function ok(data: Record<string, unknown>): ContentPart[] {
  return [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }];
}

function fail(error: string): ContentPart[] {
  return [{ type: "text", text: JSON.stringify({ ok: false, error }, null, 2) }];
}

function getScreenSize(): { width: number; height: number } {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output "$($s.Width)x$($s.Height)"`;
    const out = execSync(`powershell -Command "${ps}"`, { encoding: "utf-8" }).trim();
    const [w, h] = out.split("x").map(Number);
    return { width: w, height: h };
  } else if (platform === "darwin") {
    const out = execSync("system_profiler SPDisplaysDataType | grep Resolution", { encoding: "utf-8" }).trim();
    const m = out.match(/(\d+)\s*x\s*(\d+)/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  } else {
    const out = execSync("xdpyinfo | grep dimensions", { encoding: "utf-8" }).trim();
    const m = out.match(/(\d+)x(\d+)/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 1920, height: 1080 };
}

function resolveCoordinates(args: Record<string, unknown>): [number, number] {
  if (args.x !== undefined && args.y !== undefined) {
    return [args.x as number, args.y as number];
  }
  if (args.norm_x !== undefined && args.norm_y !== undefined) {
    const size = getScreenSize();
    return [
      Math.round(size.width * (args.norm_x as number) / 1000),
      Math.round(size.height * (args.norm_y as number) / 1000),
    ];
  }
  throw new Error("需要提供 x/y（像素坐标）或 norm_x/norm_y（归一化坐标 0-1000）");
}

// ---------------------------------------------------------------------------
// 平台操作实现
// ---------------------------------------------------------------------------

function mouseMove(x: number, y: number): void {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`;
    execSync(`powershell -Command "${ps}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    spawnSync("cliclick", ["m:" + x + "," + y]);
  } else {
    spawnSync("xdotool", ["mousemove", String(x), String(y)]);
  }
}

function mouseClick(x: number, y: number, button: string = "left"): void {
  const platform = os.platform();
  if (platform === "win32") {
    const btnCode = button === "right" ? 2 : 1;
    const downFlag = btnCode === 2 ? "0x0008" : "0x0002";
    const upFlag = btnCode === 2 ? "0x0010" : "0x0004";
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
      '$sig = @"',
      "[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);",
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse -Namespace Win32 -PassThru",
      `$m::mouse_event(${downFlag},0,0,0,0)`,
      `$m::mouse_event(${upFlag},0,0,0,0)`,
    ].join("; ");
    execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    const clickCmd = button === "right" ? "rc" : "c";
    spawnSync("cliclick", [clickCmd + ":" + x + "," + y]);
  } else {
    mouseMove(x, y);
    const btn = button === "right" ? "3" : button === "middle" ? "2" : "1";
    spawnSync("xdotool", ["click", "--button", btn]);
  }
}

function mouseDoubleClick(x: number, y: number): void {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
      '$sig = @"',
      "[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);",
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse2 -Namespace Win32 -PassThru",
      "$m::mouse_event(0x0002,0,0,0,0); $m::mouse_event(0x0004,0,0,0,0)",
      "Start-Sleep -Milliseconds 50",
      "$m::mouse_event(0x0002,0,0,0,0); $m::mouse_event(0x0004,0,0,0,0)",
    ].join("; ");
    execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    spawnSync("cliclick", ["dc:" + x + "," + y]);
  } else {
    mouseMove(x, y);
    spawnSync("xdotool", ["click", "--repeat", "2", "--delay", "50", "1"]);
  }
}

function mouseDrag(sx: number, sy: number, ex: number, ey: number): void {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy})`,
      '$sig = @"',
      "[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);",
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse3 -Namespace Win32 -PassThru",
      "$m::mouse_event(0x0002,0,0,0,0)",
      "Start-Sleep -Milliseconds 50",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${ex},${ey})`,
      "Start-Sleep -Milliseconds 50",
      "$m::mouse_event(0x0004,0,0,0,0)",
    ].join("; ");
    execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    spawnSync("cliclick", ["dd:" + sx + "," + sy, "dm:" + ex + "," + ey, "du:" + ex + "," + ey]);
  } else {
    spawnSync("xdotool", ["mousemove", String(sx), String(sy), "mousedown", "1", "mousemove", String(ex), String(ey), "mouseup", "1"]);
  }
}

function keyboardType(text: string): void {
  const platform = os.platform();
  if (platform === "win32") {
    const escaped = text.replace(/'/g, "''");
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
    execSync(`powershell -Command "${ps}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    spawnSync("cliclick", ["t:" + text]);
  } else {
    spawnSync("xdotool", ["type", "--clearmodifiers", text]);
  }
}

function keyboardHotkey(keys: string): void {
  const platform = os.platform();
  const keyNames = keys.split(/\s+/);
  if (platform === "win32") {
    let sendKeysStr = "";
    for (const k of keyNames) {
      const lower = k.toLowerCase();
      const map: Record<string, string> = {
        ctrl: "^", control: "^", alt: "%", shift: "+",
        enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}",
        escape: "{ESC}", esc: "{ESC}", space: " ",
        backspace: "{BACKSPACE}", delete: "{DELETE}",
        up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
        home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
        f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}",
        f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}",
        f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
      };
      sendKeysStr += map[lower] ?? k;
    }
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysStr}')`;
    execSync(`powershell -Command "${ps}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    const macKeys = keyNames.map(k => {
      const map: Record<string, string> = { ctrl: "cmd", control: "cmd", alt: "alt", shift: "shift", meta: "cmd", cmd: "cmd" };
      return map[k.toLowerCase()] ?? k;
    });
    spawnSync("cliclick", ["kp:" + macKeys.join("+")]);
  } else {
    spawnSync("xdotool", ["key", keyNames.join("+")]);
  }
}

function mouseScroll(direction: string, amount: number): void {
  const platform = os.platform();
  if (platform === "win32") {
    const delta = direction === "up" ? (amount * 120) : -(amount * 120);
    const ps = [
      '$sig = @"',
      "[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);",
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse4 -Namespace Win32 -PassThru",
      `$m::mouse_event(0x0800,0,0,${delta},0)`,
    ].join("; ");
    execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });
  } else if (platform === "darwin") {
    const scrollAmount = direction === "up" ? amount : -amount;
    spawnSync("cliclick", ["w:" + scrollAmount]);
  } else {
    const btn = direction === "up" ? "4" : "5";
    for (let i = 0; i < amount; i++) {
      spawnSync("xdotool", ["click", btn]);
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function appendScreenshot(result: ContentPart[], doScreenshot: boolean): Promise<ContentPart[]> {
  if (!doScreenshot) return result;
  const screenshotParts = await takeScreenshot(false);
  return [...result, ...screenshotParts];
}

export async function mouseKeyboard(args: Record<string, unknown>): Promise<ContentPart[]> {
  const action = args.action as string;
  if (!action) return fail("action 参数必填");

  const screenshotAfter = !!args.screenshot_after;

  try {
    switch (action) {
      case "get_screen_size": {
        const size = getScreenSize();
        return ok(size);
      }

      case "click": {
        const [x, y] = resolveCoordinates(args);
        mouseClick(x, y, (args.button as string) ?? "left");
        return appendScreenshot(ok({ action: "click", x, y }), screenshotAfter);
      }

      case "double_click": {
        const [x, y] = resolveCoordinates(args);
        mouseDoubleClick(x, y);
        return appendScreenshot(ok({ action: "double_click", x, y }), screenshotAfter);
      }

      case "right_click": {
        const [x, y] = resolveCoordinates(args);
        mouseClick(x, y, "right");
        return appendScreenshot(ok({ action: "right_click", x, y }), screenshotAfter);
      }

      case "move": {
        const [x, y] = resolveCoordinates(args);
        mouseMove(x, y);
        return ok({ action: "move", x, y });
      }

      case "drag": {
        let sx: number, sy: number, ex: number, ey: number;
        if (args.start_norm_x !== undefined) {
          const size = getScreenSize();
          sx = Math.round(size.width * (args.start_norm_x as number) / 1000);
          sy = Math.round(size.height * (args.start_norm_y as number) / 1000);
          ex = Math.round(size.width * (args.end_norm_x as number) / 1000);
          ey = Math.round(size.height * (args.end_norm_y as number) / 1000);
        } else {
          sx = args.start_x as number;
          sy = args.start_y as number;
          ex = args.end_x as number;
          ey = args.end_y as number;
        }
        mouseDrag(sx, sy, ex, ey);
        return appendScreenshot(ok({ action: "drag", startX: sx, startY: sy, endX: ex, endY: ey }), screenshotAfter);
      }

      case "type": {
        const text = args.text as string;
        if (!text) return fail("type 操作需要 text 参数");
        keyboardType(text);
        return appendScreenshot(ok({ action: "type", text }), screenshotAfter);
      }

      case "hotkey": {
        const keys = args.keys as string;
        if (!keys) return fail("hotkey 操作需要 keys 参数");
        keyboardHotkey(keys);
        return appendScreenshot(ok({ action: "hotkey", keys }), screenshotAfter);
      }

      case "scroll": {
        const direction = (args.direction as string) ?? "down";
        const amount = (args.amount as number) ?? 3;
        if (args.x !== undefined || args.norm_x !== undefined) {
          const [x, y] = resolveCoordinates(args);
          mouseMove(x, y);
        }
        mouseScroll(direction, amount);
        return appendScreenshot(ok({ action: "scroll", direction, amount }), screenshotAfter);
      }

      default:
        return fail(`未知操作: ${action}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(msg);
  }
}
