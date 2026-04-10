/**
 * bash_output 工具 — 对齐 tools-contract §3.8。
 * 增量读取后台会话输出；省略 bash_id 时列出所有会话。
 */

import type { BackgroundRegistry } from "./background_registry.js";
import { validateArgs } from "./param_validator.js";

interface BashOutputArgs {
  bash_id?: string;
  filter?: string;
}

export function bashOutputTool(
  bgRegistry: BackgroundRegistry,
  args: Record<string, unknown>,
): string {
  const validated = validateArgs<BashOutputArgs>(args, {
    bash_id: { type: "string" },
    filter: { type: "string" },
  });

  const bashId = validated.bash_id?.trim();
  if (!bashId) {
    return listSessions(bgRegistry);
  }

  const session = bgRegistry.get(bashId);
  if (!session) {
    return JSON.stringify({
      ok: false,
      code: "not_found",
      bash_id: bashId,
      error: "bash_id not found (may have been garbage collected)",
    });
  }

  const delta = bgRegistry.readDelta(bashId);
  let output = delta?.output ?? "";

  if (validated.filter) {
    let re: RegExp;
    try {
      re = new RegExp(validated.filter);
    } catch {
      return JSON.stringify({
        ok: false,
        code: "invalid_filter",
        error: `invalid regex: ${validated.filter}`,
      });
    }
    output = output
      .split("\n")
      .filter((line) => re.test(line))
      .join("\n");
  }

  const result: Record<string, unknown> = {
    ok: true,
    bash_id: bashId,
    status: session.closed ? "completed" : "running",
    new_output: output,
  };
  if (session.exitCode !== null) {
    result.exit_code = session.exitCode;
  }
  if (delta && delta.droppedHeadBytes > 0) {
    result.dropped_head_bytes = delta.droppedHeadBytes;
  }
  return JSON.stringify(result);
}

function listSessions(bgRegistry: BackgroundRegistry): string {
  const sessions = bgRegistry.list().map((s) => {
    const row: Record<string, unknown> = {
      bash_id: s.id,
      command: s.command,
      cwd: s.cwd,
      pid: s.pid,
      closed: s.closed,
      started_at: s.startedAt,
    };
    if (s.exitCode !== null) {
      row.exit_code = s.exitCode;
    }
    return row;
  });
  return JSON.stringify({ ok: true, sessions });
}
