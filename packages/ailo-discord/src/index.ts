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
import { DiscordHandler } from "./discord-handler.js";

const CONFIG_PORT = Number(process.env.CONFIG_PORT) || 19804;
const configPath = join(process.cwd(), "config.json");
const BLUEPRINT_URL =
  process.env.BLUEPRINT_DISCORD_URL ??
  "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/discord.blueprint.md";

interface DiscordConfig {
  ailo: { wsUrl: string; apiKey: string; endpointId: string };
  discord: { botToken: string; httpProxy?: string };
}

const ENV_MAPPING: EnvMapping[] = [
  ...AILO_ENV_MAPPING,
  { envVar: "DISCORD_BOT_TOKEN", configPath: "discord.botToken" },
  { envVar: "DISCORD_HTTP_PROXY", configPath: "discord.httpProxy" },
];

function loadConfig(): DiscordConfig {
  const { merged } = mergeWithEnv<DiscordConfig>(readConfig<DiscordConfig>(configPath), ENV_MAPPING);
  return merged;
}

function getAiloConnection(cfg: DiscordConfig): AiloConnectionConfig {
  return { url: cfg.ailo?.wsUrl ?? "", apiKey: cfg.ailo?.apiKey ?? "", endpointId: cfg.ailo?.endpointId ?? "" };
}

const connectionState = { connected: false, endpointId: "" };
let endpointCtxRef: EndpointContext | null = null;
let connectAttempt = 0;
let connectionPending = false;
let currentStop: (() => Promise<void>) | null = null;

async function applyConnection(overrides?: AiloConnectionConfig): Promise<void> {
  const cfg = loadConfig();
  const botToken = cfg.discord?.botToken ?? "";
  if (!botToken) return;
  const ailo = overrides ?? getAiloConnection(cfg);
  if (!hasValidConfig(ailo)) return;
  if (connectionPending) return;

  connectionPending = true;
  try {
    connectAttempt = 0;
    const handler = new DiscordHandler({ botToken, httpProxy: cfg.discord?.httpProxy });

    const wrapper = {
      start: async (ctx: EndpointContext) => {
        connectionPending = false; endpointCtxRef = ctx;
        connectionState.connected = true; connectionState.endpointId = ailo.endpointId;
        await handler.start(ctx);
        console.log("[discord] Discord 端点已启动");
      },
      stop: async () => {
        currentStop = null; connectionPending = false; endpointCtxRef = null;
        connectionState.connected = false; connectionState.endpointId = "";
        await handler.stop();
        console.log("[discord] Discord 端点已停止");
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
        console.error(`[discord] 连接失败，${(delay / 1000).toFixed(1)}s 后重试 (${err.message})`);
        await new Promise((r) => setTimeout(r, delay));
        await client.reconnect(undefined, { url: latest.url, apiKey: latest.apiKey, endpointId: latest.endpointId });
      },
    });
  } catch (e) { connectionPending = false; throw e; }
}

async function main(): Promise<void> {
  startEndpointConfigServer({
    endpointName: "Discord",
    defaultPort: CONFIG_PORT,
    configPath,
    platformFields: [
      { key: "discord.botToken", label: "Bot Token", envVar: "DISCORD_BOT_TOKEN", type: "password", required: true },
      { key: "discord.httpProxy", label: "HTTP Proxy（可选）", envVar: "DISCORD_HTTP_PROXY", placeholder: "http://127.0.0.1:7890" },
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
  if (cfg.discord?.botToken && hasValidConfig(getAiloConnection(cfg))) {
    await applyConnection();
  } else {
    console.log("[discord] 未检测到完整配置，请打开配置页填写 Discord 与 Ailo 连接信息并保存。");
    console.log(`[discord] 配置界面: http://127.0.0.1:${CONFIG_PORT}`);
  }
}

main().catch((e) => { console.error("[discord] 启动失败:", e); process.exit(1); });
