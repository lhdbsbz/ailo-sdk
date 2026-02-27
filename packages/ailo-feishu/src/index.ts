#!/usr/bin/env node
/**
 * Ailo 飞书 Channel — 自带配置界面：打开网页填写飞书应用 + Ailo 连接信息，保存后生效。
 * 流程仿照 ailo-desktop：先起配置服务，有完整配置则连接；保存后重连或首次连接。
 */

import { config as loadEnv } from "dotenv";
import {
  runEndpoint,
  type EndpointContext,
  type EndpointClient,
} from "@lmcl/ailo-endpoint-sdk";
import { join } from "path";
import { FeishuHandler } from "./feishu-handler.js";
import { startConfigServer } from "./config_server.js";

loadEnv();

const envFilePath = join(process.cwd(), ".env");
const rawPort = Number(process.env.CONFIG_PORT ?? 19802);
const CONFIG_PORT =
  Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 19802;
const BLUEPRINT_FEISHU_URL =
  process.env.BLUEPRINT_FEISHU_URL ??
  "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/feishu-channel.blueprint.md";

/** 从 .env 读取 Ailo 连接配置 */
function loadAiloConfig(): { url: string; apiKey: string; endpointId: string; displayName?: string } {
  loadEnv({ path: envFilePath });
  return {
    url: process.env.AILO_WS_URL ?? "",
    apiKey: process.env.AILO_API_KEY ?? "",
    endpointId: process.env.AILO_ENDPOINT_ID ?? "",
    displayName: process.env.DISPLAY_NAME,
  };
}

function hasValidAiloConfig(c: { url: string; apiKey: string; endpointId: string }): boolean {
  return !!(c.url && c.apiKey && c.endpointId);
}

function hasValidFeishuConfig(): boolean {
  loadEnv({ path: envFilePath });
  const appId = process.env.FEISHU_APP_ID ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? "";
  return !!(appId && appSecret);
}

/** 退避延迟（毫秒） */
function backoffDelayMs(attempt: number): number {
  const base = 1000;
  const max = 60_000;
  const raw = Math.min(base * 2 ** attempt, max);
  const jitter = raw * 0.1 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(raw + jitter));
}

const connectionState = {
  connected: false,
  endpointId: "",
  displayName: process.env.DISPLAY_NAME ?? "飞书",
};

let endpointCtxRef: EndpointContext | null = null;
let connectAttempt = 0;
/** 防止在首次连接成功前多次保存导致重复 runEndpoint */
let connectionPending = false;
/** 当前端点的 stop，用于保存配置后先断开再用新配置重连（飞书 + Ailo 一并生效） */
let currentStop: (() => Promise<void>) | null = null;

async function applyConnection(ailoOverrides?: {
  url: string;
  apiKey: string;
  endpointId: string;
  displayName?: string;
}): Promise<void> {
  loadEnv({ path: envFilePath });
  const appId = process.env.FEISHU_APP_ID ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? "";
  const ailo = ailoOverrides ?? loadAiloConfig();

  if (!appId || !appSecret) return;
  if (!hasValidAiloConfig(ailo)) return;
  if (connectionPending) return;

  connectionPending = true;
  try {
    connectAttempt = 0;
    const handler = new FeishuHandler({ appId, appSecret });

    const wrapper = {
      start: async (ctx: EndpointContext) => {
        connectionPending = false;
        endpointCtxRef = ctx;
        connectionState.connected = true;
        connectionState.endpointId = ailo.endpointId;
        connectionState.displayName = ailo.displayName ?? "飞书";
        await handler.start(ctx);
        console.log("[feishu] 飞书端点已启动");
      },
      stop: async () => {
        currentStop = null;
        connectionPending = false;
        endpointCtxRef = null;
        connectionState.connected = false;
        connectionState.endpointId = "";
        connectionState.displayName = "飞书";
        await handler.stop();
        console.log("[feishu] 飞书端点已停止");
      },
    };

    currentStop = () => wrapper.stop();
    runEndpoint({
      handler: wrapper,
      displayName: ailo.displayName ?? "飞书",
      caps: ["message", "tool_execute"],
      ailoWsUrl: ailo.url,
      ailoApiKey: ailo.apiKey,
      endpointId: ailo.endpointId,
      blueprints: [BLUEPRINT_FEISHU_URL],
      instructions:
        '外部用户：昵称为"外部用户N"的是非本组织成员。同一编号始终对应同一人。',
      toolHandlers: {
        send: async (args: Record<string, unknown>) => {
          const atts = ((args.attachments as any[]) ?? []).map((a: any) => ({
            type: a.type,
            file_path: a.path,
            base64: a.base64,
            mime: a.mime,
            name: a.name,
            duration: a.duration,
          }));
          await handler.sendText(args.chat_id as string, (args.text as string) ?? "", atts);
          return `已发送到 ${args.chat_id}`;
        },
      },
      onConnectFailure: async (err: Error, client: EndpointClient) => {
        const latest = loadAiloConfig();
        if (!hasValidAiloConfig(latest)) {
          console.error("[feishu] Ailo 连接配置不完整，请于配置页填写 AILO_WS_URL、AILO_API_KEY、AILO_ENDPOINT_ID 后保存并重启进程。");
          connectionPending = false;
          process.exit(1);
        }
        const delay = backoffDelayMs(connectAttempt++);
        console.error(
          `[feishu] 连接失败，${(delay / 1000).toFixed(1)}s 后使用最新配置重试 (${err.message})`
        );
        await new Promise((r) => setTimeout(r, delay));
        await client.reconnect(undefined, {
          url: latest.url,
          apiKey: latest.apiKey,
          endpointId: latest.endpointId,
          displayName: latest.displayName,
        });
      },
    });
  } catch (e) {
    connectionPending = false;
    throw e;
  }
}

async function main(): Promise<void> {
  startConfigServer({
    port: CONFIG_PORT,
    envFilePath,
    getConnectionStatus: () => connectionState,
    onConfigSaved: async (config) => {
      const ailo = {
        url: config.ailoWsUrl,
        apiKey: config.ailoApiKey,
        endpointId: config.endpointId,
        displayName: config.displayName,
      };
      if (endpointCtxRef && currentStop) {
        endpointCtxRef.client.close();
        await currentStop();
        await applyConnection(ailo);
      } else if (endpointCtxRef) {
        await endpointCtxRef.client.reconnect(undefined, ailo);
      } else if (!connectionPending) {
        await applyConnection(ailo);
      }
    },
  });

  loadEnv({ path: envFilePath });
  const feishuOk = hasValidFeishuConfig();
  const ailoCfg = loadAiloConfig();
  const ailoOk = hasValidAiloConfig(ailoCfg);

  if (feishuOk && ailoOk) {
    await applyConnection();
  } else {
    console.log("[feishu] 未检测到完整配置，请打开配置页填写飞书应用与 Ailo 连接信息并保存。");
    console.log(`[feishu] 配置界面: http://127.0.0.1:${CONFIG_PORT}`);
  }
}

main().catch((e) => {
  console.error("[feishu] 启动失败:", e);
  process.exit(1);
});
