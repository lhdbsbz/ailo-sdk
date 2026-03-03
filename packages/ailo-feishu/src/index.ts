#!/usr/bin/env node
/**
 * Ailo 飞书端点 — 自带配置界面：打开网页填写飞书应用 + Ailo 连接信息，保存后生效。
 * 先起配置服务，有完整配置则连接；保存后重连或首次连接。
 */

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
import { FeishuHandler } from "./feishu-handler.js";

const CONFIG_PORT = Number(process.env.CONFIG_PORT) || 19802;
const configPath = join(process.cwd(), "config.json");
const BLUEPRINT_FEISHU_URL =
  process.env.BLUEPRINT_FEISHU_URL ??
  "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/feishu.blueprint.md";

interface FeishuConfig {
  ailo: { wsUrl: string; apiKey: string; endpointId: string };
  feishu: { appId: string; appSecret: string };
}

const ENV_MAPPING: EnvMapping[] = [
  ...AILO_ENV_MAPPING,
  { envVar: "FEISHU_APP_ID", configPath: "feishu.appId" },
  { envVar: "FEISHU_APP_SECRET", configPath: "feishu.appSecret" },
];

function loadConfig(): FeishuConfig {
  const raw = readConfig<FeishuConfig>(configPath);
  const { merged } = mergeWithEnv<FeishuConfig>(raw, ENV_MAPPING);
  return merged;
}

function getAiloConnection(cfg: FeishuConfig): AiloConnectionConfig {
  return {
    url: cfg.ailo?.wsUrl ?? "",
    apiKey: cfg.ailo?.apiKey ?? "",
    endpointId: cfg.ailo?.endpointId ?? "",
  };
}

function hasValidFeishuConfig(cfg: FeishuConfig): boolean {
  return !!(cfg.feishu?.appId && cfg.feishu?.appSecret);
}

const connectionState = {
  connected: false,
  endpointId: "",
};

let endpointCtxRef: EndpointContext | null = null;
let connectAttempt = 0;
let connectionPending = false;
let currentStop: (() => Promise<void>) | null = null;

async function applyConnection(overrides?: AiloConnectionConfig): Promise<void> {
  const cfg = loadConfig();
  const appId = cfg.feishu?.appId ?? "";
  const appSecret = cfg.feishu?.appSecret ?? "";
  const ailo = overrides ?? getAiloConnection(cfg);

  if (!appId || !appSecret) return;
  if (!hasValidConfig(ailo)) return;
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
        await handler.start(ctx);
        console.log("[feishu] 飞书端点已启动");
      },
      stop: async () => {
        currentStop = null;
        connectionPending = false;
        endpointCtxRef = null;
        connectionState.connected = false;
        connectionState.endpointId = "";
        await handler.stop();
        console.log("[feishu] 飞书端点已停止");
      },
    };

    currentStop = () => wrapper.stop();
    runEndpoint({
      handler: wrapper,
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
            mime: a.mime,
            name: a.name,
            duration: a.duration,
          }));
          await handler.sendText(args.chat_id as string, (args.text as string) ?? "", atts);
          return `已发送到 ${args.chat_id}`;
        },
      },
      onConnectFailure: async (err: Error, client: EndpointClient) => {
        const latest = getAiloConnection(loadConfig());
        if (!hasValidConfig(latest)) {
          console.error("[feishu] Ailo 连接配置不完整，请于配置页填写后保存。");
          connectionPending = false;
          return;
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
        });
      },
    });
  } catch (e) {
    connectionPending = false;
    throw e;
  }
}

async function main(): Promise<void> {
  startEndpointConfigServer({
    endpointName: "飞书",
    defaultPort: CONFIG_PORT,
    configPath,
    platformFields: [
      { key: "feishu.appId", label: "飞书 App ID", envVar: "FEISHU_APP_ID", placeholder: "cli_xxx", required: true },
      { key: "feishu.appSecret", label: "飞书 App Secret", envVar: "FEISHU_APP_SECRET", type: "password", placeholder: "应用密钥", required: true },
    ],
    envMapping: ENV_MAPPING,
    getConnectionStatus: () => connectionState,
    onConfigSaved: async (config) => {
      const ailo: AiloConnectionConfig = {
        url: (config as any).ailo?.wsUrl ?? "",
        apiKey: (config as any).ailo?.apiKey ?? "",
        endpointId: (config as any).ailo?.endpointId ?? "",
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

  const cfg = loadConfig();
  const ailo = getAiloConnection(cfg);

  if (hasValidFeishuConfig(cfg) && hasValidConfig(ailo)) {
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
