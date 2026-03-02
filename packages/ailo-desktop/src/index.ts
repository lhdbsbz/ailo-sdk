#!/usr/bin/env node
/**
 * Ailo Desktop — 配置/重连/退避 流程（可复用到其他 SDK 应用）
 *
 * 1. 单进程内状态：connectionState + webchatCtxRef，配置页只起一次。
 * 2. 保存配置后：已连 → 断线并用新配置重连；未连 → 用新配置发起连接。
 * 3. 连接失败：onConnectFailure 内退避重试，每次用 loadConnectionConfig 拿最新配置再 client.reconnect。
 *
 * 子命令：ailo-desktop init [--defaults] — 初始化 config.json 与 Skills 目录（见 cli.ts）。
 */

const [, , subcommand] = process.argv;
if (subcommand === "init") {
  import("./cli.js")
    .then(({ runInit }) =>
      runInit(process.argv.includes("--defaults"))
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(e);
          process.exit(1);
        }),
    )
    .catch((e) => {
      console.error("init 加载失败:", e);
      process.exit(1);
    });
}
import { runEndpoint, type EndpointContext } from "@lmcl/ailo-endpoint-sdk";
import type { ContentPart } from "@lmcl/ailo-endpoint-sdk";
import { join } from "path";
import { takeScreenshot } from "./screenshot.js";
import { execTool } from "./exec_tool.js";
import { fsTool } from "./fs_tools.js";
import { LocalMCPManager } from "./mcp_manager.js";
import { sendFile } from "./send_file.js";
import { browserUse, stopBrowser } from "./browser_control.js";
import { executeCode } from "./code_executor.js";
import { startConfigServer } from "./config_server.js";
import { getCurrentTime } from "./time_tool.js";
import { mouseKeyboard } from "./mouse_keyboard.js";
import { SkillsManager } from "./skills_manager.js";
import {
  loadConnectionConfig,
  hasValidConfig,
  backoffDelayMs,
  type AiloConnectionConfig,
} from "./connection_util.js";

const BLUEPRINT_URL =
  process.env.BLUEPRINT_DESKTOP_URL ??
  join("..", "..", "blueprints", "desktop-agent.blueprint.md");
const BLUEPRINT_WEBCHAT = join("..", "..", "blueprints", "webchat-channel.blueprint.md");

const mcpManager = new LocalMCPManager();
const skillsManager = new SkillsManager();
let endpointCtx: EndpointContext | null = null;
let webchatApi: { recordAiloReply: (text: string, participantName: string) => boolean } | null = null;

async function initSubsystems(): Promise<void> {
  try {
    await mcpManager.init();
    mcpManager.startWatching();
    mcpManager.setOnToolsChanged(() => console.log("[desktop] MCP 工具变更，将触发重连"));
  } catch (e: unknown) {
    console.error("[desktop] MCP 初始化失败:", e instanceof Error ? e.message : e);
  }
  try {
    await skillsManager.init();
  } catch (e: unknown) {
    console.error("[desktop] Skills 初始化失败:", e instanceof Error ? e.message : e);
  }
}

const FS_TOOLS = [
  "read_file", "write_file", "edit_file", "append_file", "list_directory",
  "find_files", "search_content", "delete_file", "move_file", "copy_file",
];

function buildToolHandlers(): Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> = {
    screenshot: async (args) => takeScreenshot(!!args.capture_window),
    get_current_time: async () => getCurrentTime(),
    browser_use: async (args) => browserUse(args),
    execute_code: async (args) => executeCode(args),
    exec: async (args) => execTool(args),
    mouse_keyboard: async (args) => mouseKeyboard(args),
    mcp_manage: async (args) => {
      const result = await mcpManager.handle(args);
      if (result.toolsChanged) console.log("[desktop] MCP 工具列表已变更，将触发重连以更新 Ailo 工具注册");
      return result.text;
    },
    send_file: async (args) => {
      if (!endpointCtx) throw new Error("端点未就绪");
      return sendFile(endpointCtx, args.path as string);
    },
    send: async (args) => {
      const text = args.text as string;
      const participantName = args.participantName as string;
      if (!webchatApi) return "网页聊天未就绪，请先连接 Ailo 并打开配置页。";
      const ok = webchatApi.recordAiloReply(text ?? "", participantName ?? "");
      return ok ? "已发送" : "未找到对应用户或发送失败，请确认 participantName 与网页聊天中的称呼一致且用户在线。";
    },
  };
  for (const name of FS_TOOLS) {
    handlers[name] = async (args) => fsTool(name, args);
  }
  return handlers;
}

async function main(): Promise<void> {
  const port = Number(process.env.CONFIG_PORT ?? 19801) || 19801;
  const configPath = join(process.cwd(), "config.json");

  const connectionState = {
    connected: false,
    endpointId: "",
    displayName: "桌面Agent",
  };
  let webchatCtxRef: EndpointContext | null = null;
  let connectAttempt = 0;
  let endpointConnecting = false;

  async function applyConnectionConfig(overrides?: AiloConnectionConfig): Promise<void> {
    const cfg = overrides ?? loadConnectionConfig(configPath);
    if (!hasValidConfig(cfg)) return;
    if (!endpointCtx && endpointConnecting) return;

    endpointConnecting = true;
    connectAttempt = 0;
    try {
      const skills = await skillsManager.getEnabledSkillsMeta();
      runEndpoint({
        ailoWsUrl: cfg.url,
        ailoApiKey: cfg.apiKey,
        endpointId: cfg.endpointId,
        displayName: cfg.displayName ?? "桌面Agent",
        handler: {
          start: async (ctx) => {
            endpointCtx = ctx;
            endpointConnecting = false;
            connectAttempt = 0;
            connectionState.connected = true;
            connectionState.endpointId = cfg.endpointId;
            connectionState.displayName = cfg.displayName ?? "桌面Agent";
            webchatCtxRef = ctx;
            serverRef.notifyContextAttached();
            console.log("[desktop] 桌面端点已启动");
          },
          stop: async () => {
            endpointCtx = null;
            endpointConnecting = false;
            connectionState.connected = false;
            connectionState.endpointId = "";
            webchatCtxRef = null;
            await mcpManager.shutdown();
            await stopBrowser();
            console.log("[desktop] 桌面端点已停止");
          },
        },
        caps: ["message", "tool_execute"],
        blueprints: [BLUEPRINT_URL, BLUEPRINT_WEBCHAT],
        tools: mcpManager.getAllPrivateTools(),
        toolHandlers: buildToolHandlers(),
        skills,
        onConnectFailure: async (err, client) => {
          const delay = backoffDelayMs(connectAttempt++);
          console.error(`[desktop] 连接失败，${(delay / 1000).toFixed(1)}s 后使用最新配置重试 (${err.message})`);
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
              displayName: latest.displayName,
            });
          } catch (e) {
            console.error("[desktop] 重试连接失败:", e instanceof Error ? e.message : e);
          }
        },
      });
    } catch (e) {
      endpointConnecting = false;
      throw e;
    }
  }

  await initSubsystems();

  const serverRef = startConfigServer({
    mcpManager,
    skillsManager,
    getConnectionStatus: () => connectionState,
    getWebchatCtx: () => webchatCtxRef,
    port,
    configPath,
    blueprintUrl: BLUEPRINT_URL,
    blueprintLocalPath: join("..", "..", "blueprints", "desktop-agent.blueprint.md"),
    onWebchatReady: (api) => { webchatApi = api; },
    onRequestReconnect: async () => {
      if (!endpointCtx) return;
      await endpointCtx.client.reconnect(await skillsManager.getEnabledSkillsMeta());
    },
    onConnectionConfigSaved: async (config) => {
      const cfg: AiloConnectionConfig = {
        url: config.ailoWsUrl,
        apiKey: config.ailoApiKey,
        endpointId: config.endpointId,
        displayName: config.displayName,
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
    console.log("[desktop] 未检测到 Ailo 连接配置，请在配置页填写并保存，将自动尝试连接（连不上会退避重试）。");
    console.log(`[desktop] 配置界面: http://127.0.0.1:${port}`);
  }
}

if (subcommand !== "init") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
