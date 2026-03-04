import { spawn } from "child_process";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir, platform } from "os";

const MAX_OUTPUT = 50000;
const DEFAULT_TIMEOUT = 60000;

export async function executeCode(args: Record<string, unknown>): Promise<string> {
  const language = String(args.language ?? "").trim().toLowerCase();
  const code = String(args.code ?? "");

  if (!language) return JSON.stringify({ ok: false, error: "language required (python or javascript)" });
  if (!code.trim()) return JSON.stringify({ ok: false, error: "code required" });
  if (!["python", "javascript"].includes(language)) {
    return JSON.stringify({ ok: false, error: `Unsupported language: ${language}. Use python or javascript.` });
  }

  const dir = await mkdtemp(join(tmpdir(), "ailo-code-"));
  const ext = language === "python" ? "py" : "mjs";
  const file = join(dir, `script.${ext}`);
  const cmd = language === "python" ? "python3" : "node";
  const timeout = Number(args.timeout ?? DEFAULT_TIMEOUT);

  try {
    await writeFile(file, code, "utf-8");
    const result = await runProcess(cmd, [file], timeout);
    return JSON.stringify({ ok: true, ...result }, null, 2);
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: e.message });
  } finally {
    try { await unlink(file); } catch {}
  }
}

function runProcess(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const env = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
    };

    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], shell: true, env });

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + "\n...(truncated)";
    });

    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT) + "\n...(truncated)";
    });

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) stderr += "\n(process killed: timeout)";
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: null });
    });
  });
}
