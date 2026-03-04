import { spawn, spawnSync } from "child_process";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir, platform } from "os";
import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";

const MAX_OUTPUT = 50000;

/**
 * 异步执行 Python / JavaScript 代码。
 * 立即返回"已启动"，代码在后台运行，完成后通过 sendSignal("tool_result") 推送结果给 LLM。
 */
export async function executeCode(ctx: EndpointContext, args: Record<string, unknown>): Promise<string> {
  const language = String(args.language ?? "").trim().toLowerCase();
  const code = String(args.code ?? "");

  if (!language) throw new Error("language 必填 (python 或 javascript)");
  if (!code.trim()) throw new Error("code 必填");
  if (!["python", "javascript"].includes(language)) {
    throw new Error(`不支持的语言: ${language}，只支持 python 或 javascript`);
  }

  const dir = await mkdtemp(join(tmpdir(), "ailo-code-"));
  const ext = language === "python" ? "py" : "mjs";
  const file = join(dir, `script.${ext}`);
  const cmd = language === "python" ? resolvePythonCmd() : "node";

  await writeFile(file, code, "utf-8");

  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };

  const proc = spawn(cmd, [file], { stdio: ["pipe", "pipe", "pipe"], env });

  const output: string[] = [];
  proc.stdout?.on("data", (d: Buffer) => output.push(d.toString("utf-8")));
  proc.stderr?.on("data", (d: Buffer) => output.push(d.toString("utf-8")));

  proc.on("close", (exitCode) => {
    const text = output.join("").trim();
    const truncated = text.length > MAX_OUTPUT
      ? text.slice(0, MAX_OUTPUT / 2) + "\n...[截断]...\n" + text.slice(-MAX_OUTPUT / 2)
      : text;

    ctx.sendSignal("tool_result", {
      content: `[execute_code 完成] ${language}\nexit_code: ${exitCode}\n${truncated}`,
    });

    unlink(file).catch(() => {});
  });

  proc.on("error", (err) => {
    ctx.sendSignal("tool_result", {
      content: `[execute_code 失败] ${language}\n错误: ${err.message}`,
    });
    unlink(file).catch(() => {});
  });

  return `已启动 ${language} 代码执行`;
}

let _pythonCmd: string | null = null;

function resolvePythonCmd(): string {
  if (_pythonCmd) return _pythonCmd;
  const candidates = platform() === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (r.status === 0) {
      _pythonCmd = cmd;
      return cmd;
    }
  }
  _pythonCmd = candidates[0];
  return _pythonCmd;
}
