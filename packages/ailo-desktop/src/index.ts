#!/usr/bin/env node
/**
 * Ailo Desktop — 超级端点
 *
 * 集成桌面能力 + 飞书 + 钉钉 + QQ + 邮件。
 * 各平台按需配置：有完整配置才启动对应 handler 并上报对应 blueprint。
 * 未配置的平台不会被 Ailo 感知，不影响其他能力正常工作。
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
import type { ContentPart, ToolCapability } from "@lmcl/ailo-endpoint-sdk";
import { inferMime, classifyMedia, mediaPart } from "@lmcl/ailo-endpoint-sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { takeScreenshot } from "./screenshot.js";
import { execTool } from "./exec_tool.js";
import { fsTool } from "./fs_tools.js";
import { LocalMCPManager } from "./mcp_manager.js";
import { browserUse, stopBrowser } from "./browser_control.js";
import { executeCode } from "./code_executor.js";
import { startConfigServer } from "./config_server.js";
import { getCurrentTime } from "./time_tool.js";
import { mouseKeyboard } from "./mouse_keyboard.js";
import { SkillsManager } from "./skills_manager.js";
import { EmailHandler, type EmailConfig } from "./email_handler.js";
import { FeishuHandler } from "./feishu-handler.js";
import { DingTalkHandler } from "./dingtalk-handler.js";
import { QQHandler } from "./qq-handler.js";
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
const BLUEPRINT_FEISHU = join(BLUEPRINTS_DIR, "feishu.blueprint.md");
const BLUEPRINT_DINGTALK = join(BLUEPRINTS_DIR, "dingtalk.blueprint.md");
const BLUEPRINT_QQ = join(BLUEPRINTS_DIR, "qq.blueprint.md");

// ──────────────────────────────────────────────────────────────
// 配置加载：各平台 + email
// ──────────────────────────────────────────────────────────────

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

const FEISHU_ENV_MAPPING = [
  { envVar: "FEISHU_APP_ID", configPath: "feishu.appId" },
  { envVar: "FEISHU_APP_SECRET", configPath: "feishu.appSecret" },
] as const;

const DINGTALK_ENV_MAPPING = [
  { envVar: "DINGTALK_CLIENT_ID", configPath: "dingtalk.clientId" },
  { envVar: "DINGTALK_CLIENT_SECRET", configPath: "dingtalk.clientSecret" },
] as const;

const QQ_ENV_MAPPING = [
  { envVar: "QQ_APP_ID", configPath: "qq.appId" },
  { envVar: "QQ_APP_SECRET", configPath: "qq.appSecret" },
  { envVar: "QQ_API_BASE", configPath: "qq.apiBase" },
] as const;

export interface FeishuConfig { appId: string; appSecret: string }
export interface DingtalkConfig { clientId: string; clientSecret: string }
export interface QQConfig { appId: string; appSecret: string; apiBase?: string }

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

function loadFeishuConfig(configPath: string): FeishuConfig | null {
  const raw = readConfig(configPath);
  const { merged } = mergeWithEnv(raw, FEISHU_ENV_MAPPING as any);
  const f = (merged as Record<string, unknown>).feishu as Record<string, unknown> | undefined;
  if (!f?.appId || !f?.appSecret) return null;
  return { appId: f.appId as string, appSecret: f.appSecret as string };
}

function loadDingtalkConfig(configPath: string): DingtalkConfig | null {
  const raw = readConfig(configPath);
  const { merged } = mergeWithEnv(raw, DINGTALK_ENV_MAPPING as any);
  const d = (merged as Record<string, unknown>).dingtalk as Record<string, unknown> | undefined;
  if (!d?.clientId || !d?.clientSecret) return null;
  return { clientId: d.clientId as string, clientSecret: d.clientSecret as string };
}

function loadQQConfig(configPath: string): QQConfig | null {
  const raw = readConfig(configPath);
  const { merged } = mergeWithEnv(raw, QQ_ENV_MAPPING as any);
  const q = (merged as Record<string, unknown>).qq as Record<string, unknown> | undefined;
  if (!q?.appId || !q?.appSecret) return null;
  return { appId: q.appId as string, appSecret: q.appSecret as string, apiBase: q.apiBase as string | undefined };
}

// ──────────────────────────────────────────────────────────────
// 运行时状态
// ──────────────────────────────────────────────────────────────

const mcpManager = new LocalMCPManager();
const skillsManager = new SkillsManager();
let endpointCtx: EndpointContext | null = null;
let webchatApi: { recordAiloReply: (text: string, participantName: string) => boolean } | null = null;
let emailHandler: EmailHandler | null = null;
let feishuHandler: FeishuHandler | null = null;
let dingtalkHandler: DingTalkHandler | null = null;
let qqHandler: QQHandler | null = null;
let lastMcpToolSnapshot: Map<string, ToolCapability> = new Map();

function computeToolDiff(oldTools: Map<string, ToolCapability>, newTools: ToolCapability[]): {
  register: ToolCapability[];
  unregister: string[];
} {
  const newMap = new Map(newTools.map((t) => [t.name, t]));
  const register: ToolCapability[] = [];
  const unregister: string[] = [];
  for (const [name] of oldTools) {
    if (!newMap.has(name)) unregister.push(name);
  }
  for (const [name, tool] of newMap) {
    if (!oldTools.has(name)) register.push(tool);
  }
  return { register, unregister };
}

async function syncMcpToolsToServer(): Promise<void> {
  if (!endpointCtx) return;
  const currentTools = mcpManager.getAllPrivateTools();
  const { register, unregister } = computeToolDiff(lastMcpToolSnapshot, currentTools);
  if (register.length === 0 && unregister.length === 0) return;
  try {
    await endpointCtx.update({
      register: register.length > 0 ? { tools: register } : undefined,
      unregister: unregister.length > 0 ? { tools: unregister } : undefined,
    });
    lastMcpToolSnapshot = new Map(currentTools.map((t) => [t.name, t]));
    console.log(`[desktop] MCP 工具增量同步: +${register.length} -${unregister.length}`);
  } catch (e: unknown) {
    console.error("[desktop] MCP 工具增量同步失败:", e instanceof Error ? e.message : e);
  }
}

async function initSubsystems(): Promise<void> {
  try {
    await mcpManager.init();
    mcpManager.startWatching();
    mcpManager.setOnToolsChanged(() => {
      console.log("[desktop] MCP 工具变更，增量同步到 Ailo");
      syncMcpToolsToServer();
    });
  } catch (e: unknown) {
    console.error("[desktop] MCP 初始化失败:", e instanceof Error ? e.message : e);
  }
  try {
    await skillsManager.init();
  } catch (e: unknown) {
    console.error("[desktop] Skills 初始化失败:", e instanceof Error ? e.message : e);
  }
}

// ──────────────────────────────────────────────────────────────
// 平台 handler 生命周期
// ──────────────────────────────────────────────────────────────

async function startPlatformHandlers(ctx: EndpointContext, configPath: string): Promise<void> {
  // 邮件
  const emailCfg = loadEmailConfig(configPath);
  if (emailCfg) {
    emailHandler = new EmailHandler(emailCfg);
    await emailHandler.start(ctx);
    console.log("[desktop] 邮件通道已启动");
  }

  // 飞书
  const feishuCfg = loadFeishuConfig(configPath);
  if (feishuCfg) {
    feishuHandler = new FeishuHandler(feishuCfg);
    await feishuHandler.start(ctx);
    console.log("[desktop] 飞书通道已启动");
  }

  // 钉钉
  const dingtalkCfg = loadDingtalkConfig(configPath);
  if (dingtalkCfg) {
    dingtalkHandler = new DingTalkHandler(dingtalkCfg);
    await dingtalkHandler.start(ctx);
    console.log("[desktop] 钉钉通道已启动");
  }

  // QQ
  const qqCfg = loadQQConfig(configPath);
  if (qqCfg) {
    qqHandler = new QQHandler(qqCfg);
    await qqHandler.start(ctx);
    console.log("[desktop] QQ 通道已启动");
  }
}

async function stopPlatformHandlers(): Promise<void> {
  if (emailHandler) {
    await emailHandler.stop();
    emailHandler = null;
  }
  if (feishuHandler) {
    await feishuHandler.stop();
    feishuHandler = null;
  }
  if (dingtalkHandler) {
    await dingtalkHandler.stop();
    dingtalkHandler = null;
  }
  if (qqHandler) {
    await qqHandler.stop();
    qqHandler = null;
  }
}

// ──────────────────────────────────────────────────────────────
// 动态计算 blueprints（只注册已配置的平台）
// ──────────────────────────────────────────────────────────────

function buildBlueprints(configPath: string): string[] {
  const list: string[] = [BLUEPRINT_URL, BLUEPRINT_WEBCHAT];
  if (loadEmailConfig(configPath)) list.push(BLUEPRINT_EMAIL);
  if (loadFeishuConfig(configPath)) list.push(BLUEPRINT_FEISHU);
  if (loadDingtalkConfig(configPath)) list.push(BLUEPRINT_DINGTALK);
  if (loadQQConfig(configPath)) list.push(BLUEPRINT_QQ);
  return list;
}

// ──────────────────────────────────────────────────────────────
// 工具 handlers
// ──────────────────────────────────────────────────────────────

const FS_TOOLS = [
  "read_file", "write_file", "edit_file", "append_file", "list_directory",
  "find_files", "search_content", "delete_file", "move_file", "copy_file",
];

function requireEmail(): EmailHandler {
  if (!emailHandler) throw new Error("邮件未配置，请在配置页「邮件」标签中填写 IMAP/SMTP 信息");
  return emailHandler;
}

function requireFeishu(): FeishuHandler {
  if (!feishuHandler) throw new Error("飞书未配置，请在配置页「飞书」标签中填写应用信息");
  return feishuHandler;
}

function requireDingtalk(): DingTalkHandler {
  if (!dingtalkHandler) throw new Error("钉钉未配置，请在配置页「钉钉」标签中填写应用信息");
  return dingtalkHandler;
}

function requireQQ(): QQHandler {
  if (!qqHandler) throw new Error("QQ 未配置，请在配置页「QQ」标签中填写应用信息");
  return qqHandler;
}

function buildToolHandlers(): Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>> = {
    screenshot: async (args) => takeScreenshot(!!args.capture_window),
    get_current_time: async () => getCurrentTime(),
    browser_use: async (args) => browserUse(args),
    execute_code: async (args) => {
      if (!endpointCtx) throw new Error("端点未就绪");
      return executeCode(endpointCtx, args);
    },
    exec: async (args) => {
      if (!endpointCtx) throw new Error("端点未就绪");
      return execTool(endpointCtx, args);
    },
    mouse_keyboard: async (args) => mouseKeyboard(args),
    mcp_manage: async (args) => {
      const result = await mcpManager.handle(args);
      if (result.toolsChanged) syncMcpToolsToServer();
      return result.text;
    },
    send_file: async (args) => {
      if (!endpointCtx) throw new Error("端点未就绪");
      const p = args.path as string;
      if (!p) throw new Error("path 为必填参数");
      await endpointCtx.sendFile(p);
      return `文件已发送：${p}`;
    },
    // 网页聊天发送
    webchat_send: async (args) => {
      const text = args.text as string | undefined;
      const participantName = args.participantName as string;
      const attachments = (args.attachments as { path?: string }[]) ?? [];
      if (!webchatApi && attachments.length === 0) return "网页聊天未就绪，请先连接 Ailo 并打开配置页。";
      const results: string[] = [];
      // 发送文字
      if (text && webchatApi) {
        const ok = webchatApi.recordAiloReply(text, participantName ?? "");
        results.push(ok ? "文字已发送" : "文字发送失败，请确认 participantName 与网页聊天中的称呼一致且用户在线");
      }
      // 发送附件
      if (attachments.length > 0) {
        if (!endpointCtx) return "端点未就绪，无法发送附件";
        for (const att of attachments) {
          if (att.path) {
            await endpointCtx.sendFile(att.path);
            results.push(`文件已发送：${att.path}`);
          }
        }
      }
      return results.length > 0 ? results.join("；") : "请提供 text 或 attachments";
    },
    // 飞书发送
    feishu_send: async (args) => {
      const h = requireFeishu();
      const atts = ((args.attachments as any[]) ?? []).map((a: any) => ({
        type: a.type,
        file_path: a.path,
        mime: a.mime,
        name: a.name,
        duration: a.duration,
      }));
      await h.sendText(args.chat_id as string, (args.text as string) ?? "", atts);
      return `已发送到 ${args.chat_id}`;
    },
    // 钉钉发送（blueprint 中 tool name 为 send，由 blueprint 决定；这里提供底层实现）
    dingtalk_send: async (args) => {
      const h = requireDingtalk();
      await h.sendText(args.chat_id as string, (args.text as string) ?? "");
      return `已发送到 ${args.chat_id}`;
    },
    // QQ 发送
    qq_send: async (args) => {
      const h = requireQQ();
      await h.sendText(args.chat_id as string, (args.text as string) ?? "", (args.msg_id as string) ?? undefined);
      return `已发送到 ${args.chat_id}`;
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

// ──────────────────────────────────────────────────────────────
// 主函数
// ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = Number(process.env.CONFIG_PORT ?? 19801) || 19801;
  const configPath = join(process.cwd(), "config.json");

  const connectionState = { connected: false, endpointId: "" };
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
      const blueprints = buildBlueprints(configPath);
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
            lastMcpToolSnapshot = new Map(mcpManager.getAllPrivateTools().map((t) => [t.name, t]));
            serverRef.notifyContextAttached();
            await startPlatformHandlers(ctx, configPath);
            console.log("[desktop] 桌面端点已启动");
          },
          stop: async () => {
            await stopPlatformHandlers();
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
        blueprints,
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
    getBlueprintPaths: () => buildBlueprints(configPath),
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
    onFeishuConfigSaved: async () => {
      if (!endpointCtx) return;
      if (feishuHandler) {
        await feishuHandler.stop();
        feishuHandler = null;
      }
      const feishuCfg = loadFeishuConfig(configPath);
      if (feishuCfg) {
        feishuHandler = new FeishuHandler(feishuCfg);
        await feishuHandler.start(endpointCtx);
      }
    },
    getFeishuStatus: () => ({
      configured: !!loadFeishuConfig(configPath),
      running: !!feishuHandler,
    }),
    onDingtalkConfigSaved: async () => {
      if (!endpointCtx) return;
      if (dingtalkHandler) {
        await dingtalkHandler.stop();
        dingtalkHandler = null;
      }
      const dingtalkCfg = loadDingtalkConfig(configPath);
      if (dingtalkCfg) {
        dingtalkHandler = new DingTalkHandler(dingtalkCfg);
        await dingtalkHandler.start(endpointCtx);
      }
    },
    getDingtalkStatus: () => ({
      configured: !!loadDingtalkConfig(configPath),
      running: !!dingtalkHandler,
    }),
    onQQConfigSaved: async () => {
      if (!endpointCtx) return;
      if (qqHandler) {
        await qqHandler.stop();
        qqHandler = null;
      }
      const qqCfg = loadQQConfig(configPath);
      if (qqCfg) {
        qqHandler = new QQHandler(qqCfg);
        await qqHandler.start(endpointCtx);
      }
    },
    getQQStatus: () => ({
      configured: !!loadQQConfig(configPath),
      running: !!qqHandler,
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
