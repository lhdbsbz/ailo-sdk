#!/usr/bin/env node
/**
 * ailo-clawwork — Ailo endpoint for ClawWork economic survival benchmark.
 *
 * Like ailo-desktop, provides a local config UI so you can fill in
 * Ailo connection details (WS URL, API Key, Endpoint ID) from a browser.
 *
 * Start:  npm run dev
 * Open:   http://127.0.0.1:19802
 */

import { runEndpoint, type EndpointContext } from "@lmcl/ailo-endpoint-sdk";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { startConfigServer } from "./config_server.js";
import {
  loadConnectionConfig,
  hasValidConfig,
  backoffDelayMs,
  type AiloConnectionConfig,
} from "./connection_util.js";

const SIDECAR_URL = process.env.CLAWWORK_SIDECAR_URL ?? "http://localhost:8020";
const BLUEPRINT = join(__dirname, "..", "blueprints", "clawwork.blueprint.md");
const CONFIG_PORT = Number(process.env.CONFIG_PORT ?? 19802) || 19802;
const configPath = join(process.cwd(), "config.json");

// ── Sidecar HTTP helpers ────────────────────────────────────────────────────

async function sidecarGet(path: string): Promise<unknown> {
  const res = await fetch(`${SIDECAR_URL}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sidecar ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function sidecarPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SIDECAR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sidecar ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Formatters ──────────────────────────────────────────────────────────────

function formatTask(task: Record<string, unknown>): string {
  const lines = [
    `**任务已领取**`,
    ``,
    `- **Task ID**: \`${task.task_id}\``,
    `- **行业**: ${task.sector}`,
    `- **职业**: ${task.occupation}`,
    `- **报酬上限**: $${Number(task.max_payment).toFixed(2)}`,
    `- **日期**: ${task.date}`,
    ``,
    `---`,
    ``,
    `**任务要求：**`,
    ``,
    String(task.prompt),
  ];
  const refFiles = task.reference_files as string[] | undefined;
  if (refFiles && refFiles.length > 0) {
    lines.push("", "**参考文件：**", "");
    for (const f of refFiles) lines.push(`- \`${f}\``);
  }
  lines.push("", "---", "", "完成任务后，请调用 `clawwork_submit` 提交你的产出物。");
  return lines.join("\n");
}

function formatStatus(s: Record<string, unknown>): string {
  return [
    `**ClawWork 经济状态**`,
    ``,
    `- **余额**: $${Number(s.balance).toFixed(2)}`,
    `- **生存状态**: ${s.survival_status}`,
    `- **累计收入**: $${Number(s.total_work_income).toFixed(2)}`,
    `- **累计成本**: $${Number(s.total_token_cost).toFixed(4)}`,
    `- **任务进度**: ${s.completed_tasks ?? 0} / ${s.total_tasks ?? "?"} 已完成（剩余 ${s.remaining_tasks ?? "?"}）`,
    `- **当前任务**: ${s.current_task ?? "无"}`,
  ].join("\n");
}

function formatSubmitResult(r: Record<string, unknown>): string {
  const score = Number(r.evaluation_score);
  const passed = score >= 0.6;
  return [
    passed ? `**任务评估通过**` : `**任务评估未通过**`,
    ``,
    `- **评分**: ${(score * 100).toFixed(1)}%${passed ? "" : "（< 60% 不发放报酬）"}`,
    `- **报酬**: $${Number(r.payment).toFixed(2)}`,
    `- **余额**: $${Number(r.balance_after).toFixed(2)}`,
    `- **生存状态**: ${r.survival_status}`,
    ``,
    `**评语：**`,
    ``,
    String(r.feedback),
  ].join("\n");
}

function formatLeaderboard(data: Record<string, unknown>): string {
  const agents = (data.agents ?? []) as Record<string, unknown>[];
  if (agents.length === 0) return "暂无排名数据。";
  const lines = [`**ClawWork 排行榜**`, ``];
  for (const a of agents) {
    const medal = a.rank === 1 ? "1." : a.rank === 2 ? "2." : a.rank === 3 ? "3." : `${a.rank}.`;
    const quality = a.avg_quality != null ? `${(Number(a.avg_quality) * 100).toFixed(1)}%` : "N/A";
    lines.push(
      `${medal} **${a.signature}** — $${Number(a.balance).toFixed(2)} ` +
        `(收入 $${Number(a.total_work_income).toFixed(2)}, ${a.num_tasks} 任务, 质量 ${quality})`,
    );
  }
  return lines.join("\n");
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

function buildToolHandlers(): Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> {
  return {
    clawwork_get_task: async (args) => {
      const date = (args.date as string) || undefined;
      const qs = date ? `?date=${date}` : "";
      const task = (await sidecarGet(`/task${qs}`)) as Record<string, unknown>;
      return formatTask(task);
    },
    clawwork_submit: async (args) => {
      const taskId = args.task_id as string;
      if (!taskId) throw new Error("task_id is required");
      const result = (await sidecarPost("/submit", {
        task_id: taskId,
        work_summary: (args.work_summary as string) || "",
        artifact_paths: (args.artifact_paths as string[]) || [],
      })) as Record<string, unknown>;
      return formatSubmitResult(result);
    },
    clawwork_status: async () => {
      const s = (await sidecarGet("/status")) as Record<string, unknown>;
      return formatStatus(s);
    },
    clawwork_leaderboard: async () => {
      const data = (await sidecarGet("/leaderboard")) as Record<string, unknown>;
      return formatLeaderboard(data);
    },
  };
}

// ── Main (config-based connection, same pattern as ailo-desktop) ────────────

async function main(): Promise<void> {
  const connectionState = { connected: false, endpointId: "" };
  let endpointCtx: EndpointContext | null = null;
  let connectAttempt = 0;
  let endpointConnecting = false;

  async function applyConnectionConfig(overrides?: AiloConnectionConfig): Promise<void> {
    const cfg = overrides ?? loadConnectionConfig(configPath);
    if (!hasValidConfig(cfg)) return;
    if (!endpointCtx && endpointConnecting) return;

    endpointConnecting = true;
    connectAttempt = 0;
    try {
      runEndpoint({
        ailoWsUrl: cfg.url,
        ailoApiKey: cfg.apiKey,
        endpointId: cfg.endpointId,
        handler: {
          start: async (ctx) => {
            endpointCtx = ctx;
            endpointConnecting = false;
            connectAttempt = 0;
            connectionState.connected = true;
            connectionState.endpointId = cfg.endpointId;
            console.log("[clawwork] 端点已连接到 Ailo Gateway");
          },
          stop: async () => {
            endpointCtx = null;
            endpointConnecting = false;
            connectionState.connected = false;
            connectionState.endpointId = "";
            console.log("[clawwork] 端点已断开");
          },
        },
        caps: ["tool_execute"],
        blueprints: [BLUEPRINT],
        toolHandlers: buildToolHandlers(),
        onConnectFailure: async (err, client) => {
          const delay = backoffDelayMs(connectAttempt++);
          console.error(`[clawwork] 连接失败，${(delay / 1000).toFixed(1)}s 后重试 (${err.message})`);
          await new Promise((r) => setTimeout(r, delay));
          const latest = loadConnectionConfig(configPath);
          if (!hasValidConfig(latest)) {
            endpointConnecting = false;
            return;
          }
          try {
            await client.reconnect(undefined, {
              url: latest.url,
              apiKey: latest.apiKey,
              endpointId: latest.endpointId,
            });
          } catch (e) {
            console.error("[clawwork] 重试失败:", e instanceof Error ? e.message : e);
          }
        },
      });
    } catch (e) {
      endpointConnecting = false;
      throw e;
    }
  }

  startConfigServer({
    getConnectionStatus: () => connectionState,
    port: CONFIG_PORT,
    configPath,
    onConnectionConfigSaved: async (config) => {
      const cfg: AiloConnectionConfig = {
        url: config.ailoWsUrl,
        apiKey: config.ailoApiKey,
        endpointId: config.endpointId,
      };
      if (endpointCtx) {
        await endpointCtx.client.reconnect(undefined, cfg);
      } else {
        await applyConnectionConfig(cfg);
      }
    },
  });

  const initial = loadConnectionConfig(configPath);
  if (hasValidConfig(initial)) {
    await applyConnectionConfig(initial);
  } else {
    console.log("[clawwork] 未检测到 Ailo 连接配置，请在配置页填写并保存。");
    console.log(`[clawwork] 配置界面: http://127.0.0.1:${CONFIG_PORT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
