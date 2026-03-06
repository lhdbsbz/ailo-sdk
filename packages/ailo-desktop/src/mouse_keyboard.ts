import { spawnSync } from "child_process";
import * as os from "os";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";
import { DesktopStateStore } from "./desktop_state_store.js";
import { verifyDesktopAction } from "./desktop_verifier.js";
import type { DesktopActionResult, DesktopObservation, DesktopVerdict } from "./desktop_types.js";
import { captureDesktopObservation } from "./screenshot.js";

function ok(data: Record<string, unknown>): ContentPart[] {
  return [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }];
}

function fail(error: string): ContentPart[] {
  return [{ type: "text", text: JSON.stringify({ ok: false, error }, null, 2) }];
}

function runPowerShell(script: string): string {
  const r = spawnSync("powershell", ["-Command", script], { encoding: "utf-8", timeout: 10000 });
  return (r.stdout ?? "").trim();
}

function runShell(cmd: string): string {
  const r = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf-8", timeout: 10000 });
  return (r.stdout ?? "").trim();
}

function getPrimaryScreenSize(): { width: number; height: number } {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output "$($s.Width)x$($s.Height)"`;
    const out = runPowerShell(ps);
    const [w, h] = out.split("x").map(Number);
    return { width: w, height: h };
  } else if (platform === "darwin") {
    const out = runShell("system_profiler SPDisplaysDataType | grep Resolution");
    const m = out.match(/(\d+)\s*x\s*(\d+)/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  } else {
    const out = runShell("xdpyinfo | grep dimensions");
    const m = out.match(/(\d+)x(\d+)/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 1920, height: 1080 };
}

// ---------------------------------------------------------------------------
// 平台操作实现
// ---------------------------------------------------------------------------

function mouseMove(x: number, y: number): void {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`;
    runPowerShell(ps);
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
      '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse -Namespace Win32 -PassThru",
      `$m::mouse_event(${downFlag},0,0,0,0)`,
      `$m::mouse_event(${upFlag},0,0,0,0)`,
    ].join("; ");
    runPowerShell(ps);
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
      '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse2 -Namespace Win32 -PassThru",
      "$m::mouse_event(0x0002,0,0,0,0); $m::mouse_event(0x0004,0,0,0,0)",
      "Start-Sleep -Milliseconds 50",
      "$m::mouse_event(0x0002,0,0,0,0); $m::mouse_event(0x0004,0,0,0,0)",
    ].join("; ");
    runPowerShell(ps);
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
      '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse3 -Namespace Win32 -PassThru",
      "$m::mouse_event(0x0002,0,0,0,0)",
      "Start-Sleep -Milliseconds 50",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${ex},${ey})`,
      "Start-Sleep -Milliseconds 50",
      "$m::mouse_event(0x0004,0,0,0,0)",
    ].join("; ");
    runPowerShell(ps);
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
    runPowerShell(ps);
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
    runPowerShell(ps);
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
      '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);',
      '"@',
      "$m = Add-Type -MemberDefinition $sig -Name WinMouse4 -Namespace Win32 -PassThru",
      `$m::mouse_event(0x0800,0,0,${delta},0)`,
    ].join("; ");
    runPowerShell(ps);
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

interface MouseKeyboardDeps {
  stateStore?: DesktopStateStore;
}

function normalizeAction(action: string): string {
  return String(action ?? "").trim().toLowerCase();
}

function buildActionResult(result: DesktopActionResult, verdict?: DesktopVerdict, afterObservation?: DesktopObservation): ContentPart[] {
  const payload: Record<string, unknown> = {
    ok: result.accepted && result.executed,
    action_result: {
      accepted: result.accepted,
      executed: result.executed,
      action: result.action,
      timestamp: result.timestamp,
      observation_id: result.observationId,
      error: result.error,
      details: result.details,
    },
  };
  if (verdict) payload.verdict = verdict;
  if (afterObservation) {
    payload.after_observation = {
      observation_id: afterObservation.id,
      scope: afterObservation.scope,
      coordinate_space: afterObservation.coordinateSpace,
      image_width: afterObservation.imageWidth,
      image_height: afterObservation.imageHeight,
      image_path: afterObservation.image.path,
    };
  }
  const parts: ContentPart[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
  if (afterObservation) {
    parts.push({
      type: "image",
      media: {
        type: "image",
        path: afterObservation.image.path,
        mime: afterObservation.image.mime,
        name: afterObservation.image.name,
      },
    });
  }
  return parts;
}

function rejectAction(action: string, error: string): ContentPart[] {
  return buildActionResult(
    {
      accepted: false,
      executed: false,
      action,
      timestamp: Date.now(),
      error,
    },
    { status: "failure", reason: error },
  );
}

function resolveObservation(args: Record<string, unknown>, deps: MouseKeyboardDeps): DesktopObservation | null {
  const stateStore = deps.stateStore;
  if (!stateStore) return null;
  const observationId = typeof args.observation_id === "string" ? args.observation_id.trim() : "";
  if (!observationId) return null;
  const observation = stateStore.getObservation(observationId);
  if (!observation) throw new Error(`observation_id 无效或已过期: ${observationId}`);
  if (stateStore.isExpired(observation)) throw new Error(`observation 已过期，请重新 screenshot: ${observationId}`);
  return observation;
}

function requireObservation(action: string, args: Record<string, unknown>, deps: MouseKeyboardDeps): DesktopObservation {
  const observation = resolveObservation(args, deps);
  if (!observation) throw new Error(`${action} 需要 observation_id，请先调用 screenshot 获取 observation`);
  return observation;
}

function resolvePointFromObservation(
  observation: DesktopObservation,
  args: Record<string, unknown>,
  xKey: string,
  yKey: string,
  normXKey: string,
  normYKey: string,
): [number, number] {
  const { bounds } = observation.scope;
  if (args[xKey] !== undefined && args[yKey] !== undefined) {
    return [
      Math.round(bounds.x + Number(args[xKey])),
      Math.round(bounds.y + Number(args[yKey])),
    ];
  }
  if (args[normXKey] !== undefined && args[normYKey] !== undefined) {
    return [
      Math.round(bounds.x + bounds.width * Number(args[normXKey]) / 1000),
      Math.round(bounds.y + bounds.height * Number(args[normYKey]) / 1000),
    ];
  }
  throw new Error(`需要提供 ${xKey}/${yKey}（基于 observation 的局部像素坐标）或 ${normXKey}/${normYKey}（归一化坐标 0-1000）`);
}

async function captureVerificationObservation(observation: DesktopObservation, deps: MouseKeyboardDeps): Promise<DesktopObservation | null> {
  const captureOpts = observation.scope.kind === "screen" && observation.scope.screenIndex !== undefined
    ? { screen: observation.scope.screenIndex }
    : false;
  const result = await captureDesktopObservation(captureOpts);
  if (!result.observation) return null;
  deps.stateStore?.saveObservation(result.observation);
  return result.observation;
}

export async function mouseKeyboard(args: Record<string, unknown>, deps: MouseKeyboardDeps = {}): Promise<ContentPart[]> {
  const action = normalizeAction(args.action as string);
  if (!action) return fail("action 参数必填");

  const verifyAfterAction = args.verify_after_action !== false && !!(args.verify_after_action ?? args.screenshot_after);
  const verificationDelayMs = Math.max(0, Number(args.verification_delay_ms ?? 150));

  try {
    switch (action) {
      case "get_screen_size": {
        const size = getPrimaryScreenSize();
        return ok(size);
      }

      case "click": {
        const observation = requireObservation(action, args, deps);
        const [x, y] = resolvePointFromObservation(observation, args, "x", "y", "norm_x", "norm_y");
        mouseClick(x, y, (args.button as string) ?? "left");
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { x, y, button: (args.button as string) ?? "left" },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      case "double_click": {
        const observation = requireObservation(action, args, deps);
        const [x, y] = resolvePointFromObservation(observation, args, "x", "y", "norm_x", "norm_y");
        mouseDoubleClick(x, y);
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { x, y },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      case "right_click": {
        const observation = requireObservation(action, args, deps);
        const [x, y] = resolvePointFromObservation(observation, args, "x", "y", "norm_x", "norm_y");
        mouseClick(x, y, "right");
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { x, y },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      case "move": {
        const observation = requireObservation(action, args, deps);
        const [x, y] = resolvePointFromObservation(observation, args, "x", "y", "norm_x", "norm_y");
        mouseMove(x, y);
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { x, y },
        };
        deps.stateStore?.setLastAction(actionResult);
        return buildActionResult(actionResult);
      }

      case "drag": {
        const observation = requireObservation(action, args, deps);
        const [sx, sy] = resolvePointFromObservation(observation, args, "start_x", "start_y", "start_norm_x", "start_norm_y");
        const [ex, ey] = resolvePointFromObservation(observation, args, "end_x", "end_y", "end_norm_x", "end_norm_y");
        mouseDrag(sx, sy, ex, ey);
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { startX: sx, startY: sy, endX: ex, endY: ey },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      case "type": {
        const observation = requireObservation(action, args, deps);
        const text = args.text as string;
        if (!text) return rejectAction(action, "type 操作需要 text 参数");
        keyboardType(text);
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { text },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      case "hotkey": {
        const observation = requireObservation(action, args, deps);
        const keys = args.keys as string;
        if (!keys) return rejectAction(action, "hotkey 操作需要 keys 参数");
        keyboardHotkey(keys);
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { keys },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      case "scroll": {
        const observation = requireObservation(action, args, deps);
        const direction = (args.direction as string) ?? "down";
        const amount = (args.amount as number) ?? 3;
        if (args.x !== undefined || args.norm_x !== undefined) {
          const [x, y] = resolvePointFromObservation(observation, args, "x", "y", "norm_x", "norm_y");
          mouseMove(x, y);
        }
        mouseScroll(direction, amount);
        const actionResult: DesktopActionResult = {
          accepted: true,
          executed: true,
          action,
          timestamp: Date.now(),
          observationId: observation.id,
          details: { direction, amount },
        };
        deps.stateStore?.setLastAction(actionResult);
        if (!verifyAfterAction) return buildActionResult(actionResult);
        if (verificationDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
        const afterObservation = await captureVerificationObservation(observation, deps);
        const verdict = verifyDesktopAction({ beforeObservation: observation, afterObservation, actionResult });
        deps.stateStore?.setLastVerdict(verdict);
        return buildActionResult(actionResult, verdict, afterObservation ?? undefined);
      }

      default:
        return fail(`未知操作: ${action}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return rejectAction(action, msg);
  }
}
