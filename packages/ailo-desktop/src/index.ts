#!/usr/bin/env node
/**
 * Ailo Desktop — 超级端点（瘦身版）
 *
 * 保留：文件工具 + Exec/Process + MCP + Web + 配置页 + 网页聊天（WebChat）。
 * 飞书 / 微信渠道已移至 Ailo 主进程原生实现（internal/feishu、internal/weixin），
 * 这里不再承担外部通道。
 *
 * 子命令：ailo-desktop init [--defaults] [--config-dir <path>] — 初始化 config.json 与 Skills 目录（见 cli.ts）。
 */

const [, , subcommand] = process.argv;
if (subcommand === "init") {
  import("./cli.js")
    .then(({ runInit }) => {
      const args = process.argv.slice(2);
      let useDefaults = false;
      let configDir: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--defaults") useDefaults = true;
        else if ((args[i] === "--config-dir" || args[i] === "-c") && args[i + 1]) configDir = args[++i];
      }
      return runInit(useDefaults, configDir)
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(e);
          process.exit(1);
        });
    })
    .catch((e) => {
      console.error("init 加载失败:", e);
      process.exit(1);
    });
}

import {
  runEndpoint,
  type EndpointContext,
  ConsoleLogger,
  createComponentLogger,
  loadConnectionConfig,
  hasValidConfig,
  backoffDelayMs,
  promptTCPPort,
} from "@greatlhd/ailo-endpoint-sdk";
import type { ContentPart, ToolCapability, SkillMeta, AiloConnectionConfig } from "@greatlhd/ailo-endpoint-sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createComponentLogger("main", new ConsoleLogger("[desktop]"));

import {
  FS_TOOLS,
  SEARCH_TOOLS,
  BASH_TOOLS,
  WEBCHAT_SEND_TOOL,
  toToolCapabilities,
} from "./tool_definitions.js";

import { fsTool } from "./fs_tools.js";
import { PersistentShell } from "./persistent_shell.js";
import { BackgroundRegistry } from "./background_registry.js";
import { bashTool } from "./bash_tool.js";
import { bashOutputTool } from "./bash_output_tool.js";
import { bashKillTool } from "./bash_kill_tool.js";
import { globTool } from "./glob_tool.js";
import { grepTool } from "./grep_tool.js";
import { LocalMCPManager } from "./mcp_manager.js";
import { startConfigServer } from "./config_server.js";
import { CONFIG_FILENAME } from "./constants.js";
import { errMsg } from "./utils.js";
import { MCPChannel } from "./mcp/mcp-channel.js";
import { appStore, actions } from "./store/index.js";
import { initEffects, setEndpointContext } from "./store/effects.js";
import { requireAbsPath } from "./path_utils.js";
import { resetToolContext } from "./tool_context.js";

function parseArgs(): { port?: number; configDir?: string; server?: boolean } {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let configDir: string | undefined;
  let server: boolean | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      const p = Number(args[++i]);
      if (!Number.isNaN(p) && p > 0) port = p;
    } else if ((args[i] === "--config-dir" || args[i] === "-c") && args[i + 1]) configDir = args[++i];
    else if (args[i] === "--server" || args[i] === "-s") server = true;
  }
  return { port, configDir, server };
}

const { port: CLI_PORT, configDir: CLI_CONFIG_DIR, server: CLI_SERVER } = parseArgs();

function hasDisplay(): boolean {
  if (CLI_SERVER) return false;
  if (process.platform === "darwin" || process.platform === "win32") {
    return true;
  }
  return !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

const isDesktopMode = hasDisplay();

// ──────────────────────────────────────────────────────────────
// 运行时状态
// ──────────────────────────────────────────────────────────────

const mcpChannel = new MCPChannel(new LocalMCPManager());
const persistentShell = new PersistentShell();
const bgRegistry = new BackgroundRegistry();
let endpointCtx: EndpointContext | null = null;
let webchatApi: { recordAiloReply: (text: string, participantName: string) => boolean } | null = null;
let endpointConfigPath = "";
let getWebchatPageConnected: () => boolean = () => false;

const reportedEndpointTools: ToolCapability[] = [];
const reportedEndpointSkills: SkillMeta[] = [];

// ──────────────────────────────────────────────────────────────
// 端点工具定义（上报给 Ailo）
// ──────────────────────────────────────────────────────────────

function shouldReportWebchatSend(): boolean {
  return webchatApi !== null && getWebchatPageConnected();
}

function buildEndpointTools(_configPath: string): ToolCapability[] {
  const tools: ToolCapability[] = [];

  tools.push(...toToolCapabilities(FS_TOOLS));
  tools.push(...toToolCapabilities(SEARCH_TOOLS));
  tools.push(...toToolCapabilities(BASH_TOOLS));

  tools.push({
    name: "mcp_manage",
    description:
      "管理MCP（Model Context Protocol）服务器。MCP服务器提供额外的工具扩展能力。支持完整生命周期管理：查看、创建、启动、停止、更新、删除服务器。【常用操作】list=查看所有服务器，create=创建新服务器（需提供name、transport、command或url），start/stop=控制运行，tools=查看工具列表",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "start", "stop", "tools", "create", "update", "delete"],
          description: "【必填】操作类型：list=列出所有服务器, start=启动服务器, stop=停止服务器, tools=查看服务器工具, create=创建新服务器, update=更新服务器配置, delete=删除服务器",
        },
        name: { type: "string", description: "MCP服务器名称（start/stop/tools/update/delete操作时必填）" },
        transport: { type: "string", enum: ["stdio", "sse"], description: "传输方式（create/update时必填）：stdio=标准输入输出, sse=Server-Sent Events" },
        command: { type: "string", description: "启动命令（stdio模式create/update时必填），如 'npx -y @modelcontextprotocol/server-filesystem'" },
        args: { type: "array", items: { type: "string" }, description: "命令参数数组（stdio模式可选），如 ['/path/to/dir']" },
        url: { type: "string", description: "服务器URL（sse模式create/update时必填）" },
        env: { type: "object", description: "环境变量对象（可选），如 { API_KEY: 'xxx' }" },
      },
      required: ["action"],
    },
  });

  if (shouldReportWebchatSend()) {
    tools.push(...toToolCapabilities([WEBCHAT_SEND_TOOL]));
  }

  return tools;
}

async function refreshReportedEndpointTools(): Promise<void> {
  if (!endpointCtx || !endpointConfigPath) return;
  try {
    const built = buildEndpointTools(endpointConfigPath);
    reportedEndpointTools.length = 0;
    reportedEndpointTools.push(...built);
    await endpointCtx.client.reconnect(undefined, undefined, built, mcpChannel.getAllPrivateTools());
    logger.info("已按渠道就绪状态刷新端点工具列表");
  } catch (e) {
    logger.error(`刷新端点工具列表失败: ${errMsg(e)}`);
  }
}

// ──────────────────────────────────────────────────────────────
// 工具 handlers
// ──────────────────────────────────────────────────────────────

const FS_TOOL_NAMES = ["read", "write", "edit", "apply_patch"];

function buildToolHandlers(): Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> = {};

  handlers.bash = async (args) => bashTool(persistentShell, bgRegistry, args);
  handlers.bash_output = async (args) => bashOutputTool(bgRegistry, args);
  handlers.bash_kill = async (args) => bashKillTool(bgRegistry, args);
  handlers.glob = async (args) => globTool(args);
  handlers.grep = async (args) => grepTool(args);

  handlers.mcp_manage = async (args) => {
    const result = await mcpChannel.handle(args);
    return result.text;
  };

  handlers.webchat_send = async (args) => {
    const text = args.text as string | undefined;
    const participantName = args.participantName as string;
    const attachments = (args.attachments as { path?: string }[]) ?? [];
    if (!webchatApi && attachments.length === 0) {
      return [{ type: "text", text: JSON.stringify({ ok: false, error: "webchat未就绪，请先连接Ailo并打开配置页" }) }];
    }
    const results: string[] = [];
    if (text && webchatApi) {
      const ok = webchatApi.recordAiloReply(text, participantName ?? "");
      results.push(ok ? "文字已发送" : "文字发送失败，请确认participantName与网页聊天中的称呼一致且用户在线");
    }
    if (attachments.length > 0) {
      if (!endpointCtx) return [{ type: "text", text: JSON.stringify({ ok: false, error: "端点未就绪，无法发送附件" }) }];
      for (const [index, att] of attachments.entries()) {
        if (att.path) {
          const absolutePath = requireAbsPath(att.path, `attachments[${index}].path`);
          await endpointCtx.sendFile(absolutePath);
          results.push(`文件已发送：${absolutePath}`);
        }
      }
    }
    if (results.length === 0) return [{ type: "text", text: JSON.stringify({ ok: false, error: "请提供text或attachments" }) }];
    return [{ type: "text", text: JSON.stringify({ ok: true, results }) }];
  };

  for (const name of FS_TOOL_NAMES) {
    handlers[name] = async (args) => fsTool(name, args);
  }

  return handlers;
}

// ──────────────────────────────────────────────────────────────
// 主函数
// ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port =
    CLI_PORT ??
    (await promptTCPPort({
      question: "请输入配置界面端口号: ",
      onInvalid: (msg) => logger.error(msg),
    }));
  const configDir = CLI_CONFIG_DIR ?? process.cwd();
  const configPath = join(configDir, CONFIG_FILENAME);
  endpointConfigPath = configPath;
  logger.info(`配置目录: ${configDir}`);
  logger.info(`运行模式: ${isDesktopMode ? "桌面模式" : "服务器模式"}`);
  const connectionState = { connected: false, endpointId: "" };
  let webchatCtxRef: EndpointContext | null = null;
  let connectAttempt = 0;
  let endpointConnecting = false;

  const endpointInstructions = isDesktopMode
    ? "Ailo Desktop 端点 — read/write/edit/apply_patch、glob/grep、bash/bash_output/bash_kill、MCP；路径相对端点进程 cwd 解析"
    : "Ailo Server 端点 — read/write/edit/apply_patch、glob/grep、bash/bash_output/bash_kill、MCP；路径相对 cwd 解析";

  async function applyConnectionConfig(overrides?: AiloConnectionConfig): Promise<void> {
    const cfg = overrides ?? loadConnectionConfig(configPath);
    if (!hasValidConfig(cfg)) return;
    if (!endpointCtx && endpointConnecting) return;

    endpointConnecting = true;
    connectAttempt = 0;

    const builtInTools = buildEndpointTools(configPath);
    reportedEndpointTools.length = 0;
    reportedEndpointTools.push(...builtInTools);

    try {
      runEndpoint({
        ailoWsUrl: cfg.url,
        ailoApiKey: cfg.apiKey,
        endpointId: cfg.endpointId,
        handler: {
          start: async (ctx) => {
            endpointCtx = ctx;
            setEndpointContext(ctx);
            endpointConnecting = false;
            connectAttempt = 0;
            connectionState.connected = true;
            connectionState.endpointId = cfg.endpointId;
            actions.setAiloConnected(true, cfg.endpointId);
            webchatCtxRef = ctx;
            serverRef.notifyContextAttached();
            await refreshReportedEndpointTools();
            logger.info("端点已启动");
          },
          stop: async () => {
            setEndpointContext(null);
            endpointCtx = null;
            endpointConnecting = false;
            connectionState.connected = false;
            connectionState.endpointId = "";
            actions.setAiloConnected(false);
            webchatCtxRef = null;
            reportedEndpointTools.length = 0;
            reportedEndpointSkills.length = 0;
            resetToolContext();
            persistentShell.close();
            bgRegistry.close();
            await mcpChannel.shutdown();
            logger.info("端点已停止");
          },
        },
        caps: ["message", "tool_execute"],
        tools: builtInTools,
        mcpTools: mcpChannel.getAllPrivateTools(),
        instructions: endpointInstructions,
        toolHandlers: buildToolHandlers(),
        onUnknownTool: async (name: string, args: Record<string, unknown>) => {
          const idx = name.indexOf(":");
          if (idx > 0) {
            const serverName = name.slice(0, idx);
            const toolName = name.slice(idx + 1);
            if (mcpChannel.isRunning(serverName)) {
              return mcpChannel.executeToolCall(serverName, toolName, args);
            }
          }
          throw new Error(`unknown tool: ${name}`);
        },
        onConnectFailure: async (err, client) => {
          const delay = backoffDelayMs(connectAttempt++);
          logger.error(`连接失败，${(delay / 1000).toFixed(1)}s 后使用最新配置重试 (${err.message})`);
          await new Promise((r) => setTimeout(r, delay));
          const latest = loadConnectionConfig(configPath);
          if (!hasValidConfig(latest)) {
            endpointConnecting = false;
            return;
          }
          try {
            await client.reconnect(undefined, undefined, undefined, mcpChannel.getAllPrivateTools());
          } catch (e) {
            logger.error(`重试连接失败: ${errMsg(e)}`);
          }
        },
      });
    } catch (e) {
      endpointConnecting = false;
      throw e;
    }
  }

  initEffects();
  await mcpChannel.init();

  const serverRef = startConfigServer({
    mcpManager: mcpChannel.getManager(),
    getConnectionStatus: () => ({
      connected: appStore.getState().ailo.connected,
      endpointId: appStore.getState().ailo.endpointId,
    }),
    getWebchatCtx: () => webchatCtxRef,
    getEndpointCtx: () => endpointCtx,
    getEndpointTools: () => reportedEndpointTools.map(t => ({ name: t.name, description: t.description ?? "" })),
    getEndpointSkills: () => reportedEndpointSkills.map(s => ({ name: s.name, description: s.description ?? "" })),
    port,
    configPath,
    onWebchatReady: (api) => {
      webchatApi = api;
    },
    onWebchatClientsChanged: async () => {
      await refreshReportedEndpointTools();
    },
    onRequestReconnect: async () => {
      if (!endpointCtx) return;
      await endpointCtx.client.reconnect(undefined, undefined, reportedEndpointTools, mcpChannel.getAllPrivateTools());
    },
    onConnectionConfigSaved: async (config) => {
      const cfg: AiloConnectionConfig = {
        url: config.ailoWsUrl,
        apiKey: config.ailoApiKey,
        endpointId: config.endpointId,
      };
      if (endpointCtx) {
        await endpointCtx.client.reconnect(undefined, cfg, reportedEndpointTools, mcpChannel.getAllPrivateTools());
      } else {
        await applyConnectionConfig(cfg);
      }
    },
  });
  getWebchatPageConnected = () => serverRef.hasWebchatPageConnected();

  const initial = loadConnectionConfig(configPath);
  if (hasValidConfig(initial)) {
    await applyConnectionConfig(initial);
  } else {
    logger.info("未检测到 Ailo 连接配置，请在配置页填写并保存，将自动尝试连接（连不上会退避重试）。");
    logger.info(`配置界面: http://127.0.0.1:${port}`);
  }
}

if (subcommand !== "init") {
  main().catch((e) => {
    logger.error(String(e));
    process.exit(1);
  });
}
