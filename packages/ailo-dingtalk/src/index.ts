#!/usr/bin/env node
import {
  runEndpoint,
  startEndpointConfigServer,
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
import { DingTalkHandler } from "./dingtalk-handler.js";

const CONFIG_PORT = Number(process.env.CONFIG_PORT) || 19805;
const configPath = join(process.cwd(), "config.json");
const BLUEPRINT_URL =
  process.env.BLUEPRINT_DINGTALK_URL ??
  "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/dingtalk.blueprint.md";

interface DingtalkConfig {
  ailo: { wsUrl: string; apiKey: string; endpointId: string };
  dingtalk: { clientId: string; clientSecret: string };
}

const ENV_MAPPING: EnvMapping[] = [
  ...AILO_ENV_MAPPING,
  { envVar: "DINGTALK_CLIENT_ID", configPath: "dingtalk.clientId" },
  { envVar: "DINGTALK_CLIENT_SECRET", configPath: "dingtalk.clientSecret" },
];

function loadConfig(): DingtalkConfig {
  const { merged } = mergeWithEnv<DingtalkConfig>(readConfig<DingtalkConfig>(configPath), ENV_MAPPING);
  return merged;
}

function getAiloConnection(cfg: DingtalkConfig): AiloConnectionConfig {
  return { url: cfg.ailo?.wsUrl ?? "", apiKey: cfg.ailo?.apiKey ?? "", endpointId: cfg.ailo?.endpointId ?? "" };
}

const connectionState = { connected: false, endpointId: "" };
let endpointCtxRef: EndpointContext | null = null;
let connectAttempt = 0;
let connectionPending = false;
let currentStop: (() => Promise<void>) | null = null;

async function applyConnection(overrides?: AiloConnectionConfig): Promise<void> {
  const cfg = loadConfig();
  const clientId = cfg.dingtalk?.clientId ?? "";
  const clientSecret = cfg.dingtalk?.clientSecret ?? "";
  if (!clientId || !clientSecret) return;
  const ailo = overrides ?? getAiloConnection(cfg);
  if (!hasValidConfig(ailo)) return;
  if (connectionPending) return;

  connectionPending = true;
  try {
    connectAttempt = 0;
    const handler = new DingTalkHandler({ clientId, clientSecret });

    const wrapper = {
      start: async (ctx: EndpointContext) => {
        connectionPending = false; endpointCtxRef = ctx;
        connectionState.connected = true; connectionState.endpointId = ailo.endpointId;
        await handler.start(ctx);
        console.log("[dingtalk] 钉钉端点已启动");
      },
      stop: async () => {
        currentStop = null; connectionPending = false; endpointCtxRef = null;
        connectionState.connected = false; connectionState.endpointId = "";
        await handler.stop();
        console.log("[dingtalk] 钉钉端点已停止");
      },
    };

    currentStop = () => wrapper.stop();
    runEndpoint({
      handler: wrapper,
      caps: ["message", "tool_execute"],
      ailoWsUrl: ailo.url, ailoApiKey: ailo.apiKey, endpointId: ailo.endpointId,
      blueprints: [BLUEPRINT_URL],
      toolHandlers: {
        send: async (args: Record<string, unknown>) => {
          await handler.sendText(args.chat_id as string, (args.text as string) ?? "");
          return `已发送到 ${args.chat_id}`;
        },
      },
      onConnectFailure: async (err: Error, client: EndpointClient) => {
        const latest = getAiloConnection(loadConfig());
        if (!hasValidConfig(latest)) { connectionPending = false; return; }
        const delay = backoffDelayMs(connectAttempt++);
        console.error(`[dingtalk] 连接失败，${(delay / 1000).toFixed(1)}s 后重试 (${err.message})`);
        await new Promise((r) => setTimeout(r, delay));
        await client.reconnect(undefined, { url: latest.url, apiKey: latest.apiKey, endpointId: latest.endpointId });
      },
    });
  } catch (e) { connectionPending = false; throw e; }
}

async function main(): Promise<void> {
  startEndpointConfigServer({
    endpointName: "钉钉",
    defaultPort: CONFIG_PORT,
    configPath,
    platformFields: [
      { key: "dingtalk.clientId", label: "Client ID", envVar: "DINGTALK_CLIENT_ID", required: true },
      { key: "dingtalk.clientSecret", label: "Client Secret", envVar: "DINGTALK_CLIENT_SECRET", type: "password", required: true },
    ],
    envMapping: ENV_MAPPING,
    getConnectionStatus: () => connectionState,
    onConfigSaved: async (config) => {
      const ailo: AiloConnectionConfig = { url: (config as any).ailo?.wsUrl ?? "", apiKey: (config as any).ailo?.apiKey ?? "", endpointId: (config as any).ailo?.endpointId ?? "" };
      if (endpointCtxRef && currentStop) { endpointCtxRef.client.close(); await currentStop(); await applyConnection(ailo); }
      else if (endpointCtxRef) { await endpointCtxRef.client.reconnect(undefined, ailo); }
      else if (!connectionPending) { await applyConnection(ailo); }
    },
  });

  const cfg = loadConfig();
  if (cfg.dingtalk?.clientId && cfg.dingtalk?.clientSecret && hasValidConfig(getAiloConnection(cfg))) {
    await applyConnection();
  } else {
    console.log("[dingtalk] 未检测到完整配置，请打开配置页填写钉钉与 Ailo 连接信息并保存。");
    console.log(`[dingtalk] 配置界面: http://127.0.0.1:${CONFIG_PORT}`);
  }
}

main().catch((e) => { console.error("[dingtalk] 启动失败:", e); process.exit(1); });
