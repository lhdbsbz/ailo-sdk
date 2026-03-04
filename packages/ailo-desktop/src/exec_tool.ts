import { spawn } from "child_process";
import * as os from "os";
import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";

const MAX_OUTPUT = 50000;

/**
 * 异步执行 shell 命令。
 * 立即返回"已启动"，命令在后台运行，完成后通过 sendSignal("tool_result") 推送结果给 LLM。
 */
export async function execTool(ctx: EndpointContext, args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) throw new Error("command 必填");
  const cwd = (args.cwd as string) || undefined;

  const isWin = os.platform() === "win32";
  const shell = isWin ? "powershell" : "/bin/sh";
  const wrappedCommand = isWin
    ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
    : command;
  const shellArgs = isWin ? ["-Command", wrappedCommand] : ["-c", command];
  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  const proc = spawn(shell, shellArgs, { stdio: ["pipe", "pipe", "pipe"], cwd, env });

  const output: string[] = [];
  proc.stdout?.on("data", (d: Buffer) => {
    const chunk = d.toString("utf-8");
    output.push(chunk);
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const chunk = d.toString("utf-8");
    output.push(chunk);
  });

  proc.on("close", (code) => {
    const text = output.join("").trim();
    const truncated = text.length > MAX_OUTPUT
      ? text.slice(0, MAX_OUTPUT / 2) + "\n...[截断]...\n" + text.slice(-MAX_OUTPUT / 2)
      : text;

    ctx.sendSignal("tool_result", {
      content: `[exec 完成] \`${command}\`\nexit_code: ${code}\n${truncated}`,
    });
  });

  proc.on("error", (err) => {
    ctx.sendSignal("tool_result", {
      content: `[exec 失败] \`${command}\`\n错误: ${err.message}`,
    });
  });

  return `已启动: ${command}`;
}
