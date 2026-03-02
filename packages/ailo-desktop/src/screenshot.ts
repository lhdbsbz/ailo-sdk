import { spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";

export async function takeScreenshot(captureWindow = false): Promise<ContentPart[]> {
  const tmpPath = path.join(os.tmpdir(), `ailo_screenshot_${Date.now()}.png`);
  const platform = os.platform();

  if (platform === "darwin") {
    const args = captureWindow ? ["-w", tmpPath] : ["-x", tmpPath];
    spawnSync("screencapture", args);
  } else if (platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$screen=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp=New-Object System.Drawing.Bitmap($screen.Width,$screen.Height)",
      "$g=[System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($screen.Location,[System.Drawing.Point]::Empty,$screen.Size)",
      `$bmp.Save('${tmpPath.replace(/\\/g, "\\\\")}')`,
    ].join("; ");
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

  return [
    { type: "text", text: captureWindow ? "窗口截图完成" : "截图完成" },
    {
      type: "image",
      media: { type: "image", path: tmpPath, mime: "image/png", name: "screenshot.png" },
    },
  ];
}
