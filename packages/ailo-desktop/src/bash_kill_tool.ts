/**
 * bash_kill 工具 — 对齐 tools-contract §3.9。
 * SIGTERM → 2s 后 SIGKILL。
 */

import type { BackgroundRegistry } from "./background_registry.js";
import { validateArgs } from "./param_validator.js";

interface BashKillArgs {
  bash_id: string;
}

export function bashKillTool(
  bgRegistry: BackgroundRegistry,
  args: Record<string, unknown>,
): string {
  const validated = validateArgs<BashKillArgs>(args, {
    bash_id: { type: "string", required: true },
  });

  const bashId = validated.bash_id.trim();
  if (!bashId) {
    return JSON.stringify({
      ok: false,
      code: "invalid_params",
      error: "bash_id is required",
    });
  }

  const ok = bgRegistry.kill(bashId);
  if (!ok) {
    return JSON.stringify({
      ok: false,
      code: "not_found",
      bash_id: bashId,
      error: "bash_id not found",
    });
  }

  return JSON.stringify({
    ok: true,
    bash_id: bashId,
    killed: true,
    message: "SIGTERM 已发送；2s 后未退出会追送 SIGKILL",
  });
}
