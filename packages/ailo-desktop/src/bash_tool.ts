/**
 * bash 工具 — 对齐 tools-contract §3.7。
 * 前台走持久 shell（cd/export 跨调用保留）；后台独立 spawn。
 */

import type { PersistentShell } from "./persistent_shell.js";
import type { BackgroundRegistry } from "./background_registry.js";
import { validateArgs } from "./param_validator.js";

interface BashArgs {
  command: string;
  description?: string;
  timeout_ms?: number;
  run_in_background?: boolean;
  workdir?: string;
}

export async function bashTool(
  persistent: PersistentShell,
  bgRegistry: BackgroundRegistry,
  args: Record<string, unknown>,
): Promise<string> {
  const validated = validateArgs<BashArgs>(args, {
    command: { type: "string", required: true },
    description: { type: "string" },
    timeout_ms: { type: "number", default: 120_000, min: 1 },
    run_in_background: { type: "boolean", default: false },
    workdir: { type: "string" },
  });

  const command = validated.command.trim();
  if (!command) {
    return JSON.stringify({ ok: false, code: "invalid_params", error: "command is required" });
  }

  if (validated.run_in_background) {
    return runBackground(bgRegistry, validated);
  }
  return runForeground(persistent, validated);
}

async function runForeground(persistent: PersistentShell, args: BashArgs): Promise<string> {
  let timeoutMs = args.timeout_ms ?? 120_000;
  if (timeoutMs > 600_000) timeoutMs = 600_000;

  try {
    const result = await persistent.run(args.command, timeoutMs);

    if (result.timedOut) {
      return JSON.stringify({
        ok: false,
        type: "timeout",
        shell_reset: result.shellReset,
        output: result.output,
        truncated: result.truncated,
        message: `前台命令超过 ${timeoutMs}ms 未完成，shell 已重建`,
      });
    }

    return JSON.stringify({
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      output: result.output,
      truncated: result.truncated,
      ...(result.shellReset ? { shell_reset: true } : {}),
    });
  } catch (err: unknown) {
    return JSON.stringify({
      ok: false,
      code: "run_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function runBackground(bgRegistry: BackgroundRegistry, args: BashArgs): string {
  try {
    const session = bgRegistry.spawn(args.command, args.workdir);
    return JSON.stringify({
      ok: true,
      type: "started",
      bash_id: session.id,
      pid: session.pid,
      command: args.command,
      cwd: session.cwd,
      started_at: session.startedAt,
      message: "后台运行中；用 bash_output 读输出，bash_kill 终止",
    });
  } catch (err: unknown) {
    return JSON.stringify({
      ok: false,
      code: "spawn_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
