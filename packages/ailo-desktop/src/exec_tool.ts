import { spawn } from "child_process";
import * as os from "os";
import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";

const MAX_OUTPUT = 50000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟

/**
 * 异步执行 shell 命令。
 * 立即返回"已启动"，命令在后台运行，完成后通过 sendSignal("tool_result") 推送结果给 LLM。
 */
export async function execTool(ctx: EndpointContext, args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) throw new Error("command 必填");
  const cwd = (args.cwd as string) || undefined;
  const timeoutSec = Math.max(5, Math.min(600, Number(args.timeout) || DEFAULT_TIMEOUT_MS / 1000));
  const timeoutMs = timeoutSec * 1000;

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

  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timeoutHandle = null;
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
    ctx.sendSignal("tool_result", {
      content: `[exec 超时] \`${command}\`\n超过 ${timeoutMs / 1000}s 未完成，已终止`,
    });
  }, timeoutMs);

  const output: string[] = [];
  let sent = false;
  proc.stdout?.on("data", (d: Buffer) => output.push(d.toString("utf-8")));
  proc.stderr?.on("data", (d: Buffer) => output.push(d.toString("utf-8")));

  const sendResult = (content: string) => {
    if (sent) return;
    sent = true;
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    ctx.sendSignal("tool_result", { content });
  };

  proc.on("close", (code) => {
    const text = output.join("").trim();
    const truncated = text.length > MAX_OUTPUT
      ? text.slice(0, MAX_OUTPUT / 2) + "\n...[截断]...\n" + text.slice(-MAX_OUTPUT / 2)
      : text;

    sendResult(`[exec 完成] \`${command}\`\nexit_code: ${code}\n${truncated}`);
  });

  proc.on("error", (err) => {
    sendResult(`[exec 失败] \`${command}\`\n错误: ${err.message}`);
  });

  return `已启动: ${command}`;
}
