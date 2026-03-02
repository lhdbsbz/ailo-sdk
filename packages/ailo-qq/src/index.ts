#!/usr/bin/env node
import {
  runEndpoint,
  startChannelConfigServer,
  readConfig,
  mergeWithEnv,
  hasValidConfig,
  backoffDelayMs,
  AILO_ENV_MAPPING,
  type EndpointContext,
  type EndpointClient,
  type AiloConnectionConfig,
  type EnvMapping,
} from "@lmcl/ailo-endpoint-sdk";
import { join } from "path";
import { QQHandler } from "./qq-handler.js";

const CONFIG_PORT = Number(process.env.CONFIG_PORT) || 19806;
const configPath = join(process.cwd(), "config.json");
const BLUEPRINT_URL =
  process.env.BLUEPRINT_QQ_URL ??
  "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/qq-channel.blueprint.md";

interface QQConfig {
  ailo: { wsUrl: string; apiKey: string; endpointId: string; displayName?: string };
  qq: { appId: string; appSecret: string; apiBase?: string };
}

const ENV_MAPPING: EnvMapping[] = [
  ...AILO_ENV_MAPPING,
  { envVar: "QQ_APP_ID", configPath: "qq.appId" },
  { envVar: "QQ_APP_SECRET", configPath: "qq.appSecret" },
  { envVar: "QQ_API_BASE", configPath: "qq.apiBase" },
];

function loadConfig(): QQConfig {
  const { merged } = mergeWithEnv<QQConfig>(readConfig<QQConfig>(configPath), ENV_MAPPING);
  return merged;
}

function getAiloConnection(cfg: QQConfig): AiloConnectionConfig {
  return { url: cfg.ailo?.wsUrl ?? "", apiKey: cfg.ailo?.apiKey ?? "", endpointId: cfg.ailo?.endpointId ?? "", displayName: cfg.ailo?.displayName };
}

const connectionState = { connected: false, endpointId: "", displayName: "QQ" };
let endpointCtxRef: EndpointContext | null = null;
let connectAttempt = 0;
let connectionPending = false;
let currentStop: (() => Promise<void>) | null = null;

async function applyConnection(overrides?: AiloConnectionConfig): Promise<void> {
  const cfg = loadConfig();
  const appId = cfg.qq?.appId ?? "";
  const appSecret = cfg.qq?.appSecret ?? "";
  if (!appId || !appSecret) return;
  const ailo = overrides ?? getAiloConnection(cfg);
  if (!hasValidConfig(ailo)) return;
  if (connectionPending) return;

  connectionPending = true;
  try {
    connectAttempt = 0;
    const handler = new QQHandler({ appId, appSecret, apiBase: cfg.qq?.apiBase });

    const wrapper = {
      start: async (ctx: EndpointContext) => {
        connectionPending = false; endpointCtxRef = ctx;
        connectionState.connected = true; connectionState.endpointId = ailo.endpointId;
        connectionState.displayName = ailo.displayName ?? "QQ";
        await handler.start(ctx);
        console.log("[qq] QQ 端点已启动");
      },
      stop: async () => {
        currentStop = null; connectionPending = false; endpointCtxRef = null;
        connectionState.connected = false; connectionState.endpointId = "";
        await handler.stop();
        console.log("[qq] QQ 端点已停止");
      },
    };

    currentStop = () => wrapper.stop();
    runEndpoint({
      handler: wrapper,
      displayName: ailo.displayName ?? "QQ",
      caps: ["message", "tool_execute"],
      ailoWsUrl: ailo.url, ailoApiKey: ailo.apiKey, endpointId: ailo.endpointId,
      blueprints: [BLUEPRINT_URL],
      toolHandlers: {
        send: async (args: Record<string, unknown>) => {
          await handler.sendText(args.chat_id as string, (args.text as string) ?? "", (args.msg_id as string) ?? undefined);
          return `已发送到 ${args.chat_id}`;
        },
      },
      onConnectFailure: async (err: Error, client: EndpointClient) => {
        const latest = getAiloConnection(loadConfig());
        if (!hasValidConfig(latest)) { connectionPending = false; return; }
        const delay = backoffDelayMs(connectAttempt++);
        console.error(`[qq] 连接失败，${(delay / 1000).toFixed(1)}s 后重试 (${err.message})`);
        await new Promise((r) => setTimeout(r, delay));
        await client.reconnect(undefined, { url: latest.url, apiKey: latest.apiKey, endpointId: latest.endpointId, displayName: latest.displayName });
      },
    });
  } catch (e) { connectionPending = false; throw e; }
}

async function main(): Promise<void> {
  startChannelConfigServer({
    channelName: "QQ",
    defaultPort: CONFIG_PORT,
    configPath,
    platformFields: [
      { key: "qq.appId", label: "App ID", envVar: "QQ_APP_ID", required: true },
      { key: "qq.appSecret", label: "App Secret", envVar: "QQ_APP_SECRET", type: "password", required: true },
      { key: "qq.apiBase", label: "API Base（可选）", envVar: "QQ_API_BASE", placeholder: "https://api.sgroup.qq.com" },
    ],
    envMapping: ENV_MAPPING,
    getConnectionStatus: () => connectionState,
    onConfigSaved: async (config) => {
      const ailo: AiloConnectionConfig = { url: (config as any).ailo?.wsUrl ?? "", apiKey: (config as any).ailo?.apiKey ?? "", endpointId: (config as any).ailo?.endpointId ?? "", displayName: (config as any).ailo?.displayName };
      if (endpointCtxRef && currentStop) { endpointCtxRef.client.close(); await currentStop(); await applyConnection(ailo); }
      else if (endpointCtxRef) { await endpointCtxRef.client.reconnect(undefined, ailo); }
      else if (!connectionPending) { await applyConnection(ailo); }
    },
  });

  const cfg = loadConfig();
  if (cfg.qq?.appId && cfg.qq?.appSecret && hasValidConfig(getAiloConnection(cfg))) {
    await applyConnection();
  } else {
    console.log("[qq] 未检测到完整配置，请打开配置页填写 QQ 与 Ailo 连接信息并保存。");
    console.log(`[qq] 配置界面: http://127.0.0.1:${CONFIG_PORT}`);
  }
}

main().catch((e) => { console.error("[qq] 启动失败:", e); process.exit(1); });
