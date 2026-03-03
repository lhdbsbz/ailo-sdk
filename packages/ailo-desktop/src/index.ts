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
import { inferMime, classifyMedia, mediaPart } from "@lmcl/ailo-endpoint-sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
import { EmailHandler, type EmailConfig } from "./email_handler.js";
import {
  loadConnectionConfig,
  hasValidConfig,
  backoffDelayMs,
  readConfig,
  mergeWithEnv,
  type AiloConnectionConfig,
} from "./connection_util.js";

const BLUEPRINTS_DIR = join(__dirname, "..", "..", "..", "blueprints");
const BLUEPRINT_URL =
  process.env.BLUEPRINT_DESKTOP_URL ??
  join(BLUEPRINTS_DIR, "desktop-agent.blueprint.md");
const BLUEPRINT_WEBCHAT = join(BLUEPRINTS_DIR, "webchat.blueprint.md");
const BLUEPRINT_EMAIL = join(BLUEPRINTS_DIR, "email.blueprint.md");

const EMAIL_ENV_MAPPING = [
  { envVar: "IMAP_HOST", configPath: "email.imapHost" },
  { envVar: "IMAP_USER", configPath: "email.imapUser" },
  { envVar: "IMAP_PASSWORD", configPath: "email.imapPassword" },
  { envVar: "IMAP_PORT", configPath: "email.imapPort" },
  { envVar: "SMTP_HOST", configPath: "email.smtpHost" },
  { envVar: "SMTP_PORT", configPath: "email.smtpPort" },
  { envVar: "SMTP_USER", configPath: "email.smtpUser" },
  { envVar: "SMTP_PASSWORD", configPath: "email.smtpPassword" },
] as const;

const mcpManager = new LocalMCPManager();
const skillsManager = new SkillsManager();
let endpointCtx: EndpointContext | null = null;
let webchatApi: { recordAiloReply: (text: string, participantName: string) => boolean } | null = null;
let emailHandler: EmailHandler | null = null;

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

function loadEmailConfig(configPath: string): EmailConfig | null {
  const raw = readConfig(configPath);
  const { merged } = mergeWithEnv(raw, EMAIL_ENV_MAPPING as any);
  const e = (merged as Record<string, unknown>).email as Record<string, unknown> | undefined;
  if (!e?.imapHost || !e?.imapUser || !e?.imapPassword) return null;
  return {
    imapHost: e.imapHost as string,
    imapPort: Number(e.imapPort) || 993,
    imapUser: e.imapUser as string,
    imapPassword: e.imapPassword as string,
    smtpHost: (e.smtpHost as string) || undefined,
    smtpPort: e.smtpPort ? Number(e.smtpPort) : undefined,
    smtpUser: (e.smtpUser as string) || undefined,
    smtpPassword: (e.smtpPassword as string) || undefined,
  };
}

const FS_TOOLS = [
  "read_file", "write_file", "edit_file", "append_file", "list_directory",
  "find_files", "search_content", "delete_file", "move_file", "copy_file",
];

function requireEmail(): EmailHandler {
  if (!emailHandler) throw new Error("邮件未配置，请在配置页「邮件」标签中填写 IMAP/SMTP 信息");
  return emailHandler;
}

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
    // ── 邮件工具 ──
    email_send: async (args) => {
      const h = requireEmail();
      await h.send({ to: args.to as string, cc: args.cc as string | undefined, bcc: args.bcc as string | undefined, subject: args.subject as string | undefined, body: args.body as string, html: args.html as string | undefined, attachments: args.attachments as any });
      return `邮件已发送至 ${args.to}`;
    },
    email_reply: async (args) => {
      const h = requireEmail();
      await h.reply({ uid: args.uid as number, folder: args.folder as string | undefined, body: args.body as string, html: args.html as string | undefined, attachments: args.attachments as any });
      return `已回复 uid=${args.uid}`;
    },
    email_forward: async (args) => {
      const h = requireEmail();
      await h.forward({ uid: args.uid as number, folder: args.folder as string | undefined, to: args.to as string, cc: args.cc as string | undefined, bcc: args.bcc as string | undefined, body: args.body as string | undefined });
      return `已转发至 ${args.to}`;
    },
    email_list: async (args) => {
      const h = requireEmail();
      const items = await h.list({ folder: args.folder as string | undefined, limit: args.limit as number | undefined, offset: args.offset as number | undefined, unreadOnly: args.unread_only as boolean | undefined });
      const lines = items.map((i) => `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`);
      return lines.length ? lines.join("\n") : "（无邮件）";
    },
    email_read: async (args) => {
      const h = requireEmail();
      const d = await h.read({ uid: args.uid as number, folder: args.folder as string | undefined });
      if (!d) throw new Error(`uid=${args.uid} 不存在`);
      const att = d.attachments.length ? `\n附件: ${d.attachments.map((a) => `${a.filename} (${a.size}B)`).join(", ")}` : "";
      return `from: ${d.from}\nto: ${d.to}\nsubject: ${d.subject}\ndate: ${d.date}\n\n${d.text ?? d.html ?? ""}${att}`;
    },
    email_search: async (args) => {
      const h = requireEmail();
      const items = await h.search({ query: args.query as string | undefined, from: args.from as string | undefined, to: args.to as string | undefined, subject: args.subject as string | undefined, since: args.since as string | undefined, until: args.until as string | undefined, folder: args.folder as string | undefined, limit: args.limit as number | undefined });
      const lines = items.map((i) => `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`);
      return lines.length ? lines.join("\n") : "（无匹配）";
    },
    email_mark_read: async (args) => {
      const h = requireEmail();
      const uids = args.uids as number[];
      await h.markRead({ uids, read: args.read as boolean, folder: args.folder as string | undefined });
      return `已标记 ${uids.length} 封为${args.read ? "已读" : "未读"}`;
    },
    email_move: async (args) => {
      const h = requireEmail();
      const uids = args.uids as number[];
      await h.move({ uids, folder: args.folder as string, fromFolder: args.from_folder as string | undefined });
      return `已移动 ${uids.length} 封到 ${args.folder}`;
    },
    email_delete: async (args) => {
      const h = requireEmail();
      const uids = args.uids as number[];
      await h.deleteMessages({ uids, folder: args.folder as string | undefined });
      return `已删除 ${uids.length} 封`;
    },
    email_get_attachment: async (args) => {
      const h = requireEmail();
      const filename = args.filename as string;
      const localPath = await h.downloadAttachment({ uid: args.uid as number, folder: args.folder as string | undefined, filename });
      if (!localPath) throw new Error(`附件 ${filename} 不存在`);
      const mime = inferMime(localPath);
      const mediaType = classifyMedia(mime);
      return [mediaPart(mediaType, { type: mediaType, path: localPath, mime, name: filename })];
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
        handler: {
          start: async (ctx) => {
            endpointCtx = ctx;
            endpointConnecting = false;
            connectAttempt = 0;
            connectionState.connected = true;
            connectionState.endpointId = cfg.endpointId;
            webchatCtxRef = ctx;
            serverRef.notifyContextAttached();
            // 启动邮件通道
            const emailCfg = loadEmailConfig(configPath);
            if (emailCfg) {
              emailHandler = new EmailHandler(emailCfg);
              await emailHandler.start(ctx);
            }
            console.log("[desktop] 桌面端点已启动");
          },
          stop: async () => {
            if (emailHandler) {
              await emailHandler.stop();
              emailHandler = null;
            }
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
        blueprints: [BLUEPRINT_URL, BLUEPRINT_WEBCHAT, BLUEPRINT_EMAIL],
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
    blueprintLocalPath: join(BLUEPRINTS_DIR, "desktop-agent.blueprint.md"),
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
      };
      if (endpointCtx) {
        await endpointCtx.client.reconnect(undefined, cfg);
      } else {
        await applyConnectionConfig(cfg);
      }
    },
    onEmailConfigSaved: async () => {
      if (!endpointCtx) return;
      if (emailHandler) {
        await emailHandler.stop();
        emailHandler = null;
      }
      const emailCfg = loadEmailConfig(configPath);
      if (emailCfg) {
        emailHandler = new EmailHandler(emailCfg);
        await emailHandler.start(endpointCtx);
      }
    },
    getEmailStatus: () => ({
      configured: !!loadEmailConfig(configPath),
      running: emailHandler?.running ?? false,
    }),
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
