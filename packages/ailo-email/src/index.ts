#!/usr/bin/env node
import {
  runEndpoint,
  startChannelConfigServer,
  readConfig,
  mergeWithEnv,
  hasValidConfig,
  backoffDelayMs,
  AILO_ENV_MAPPING,
  mediaPart,
  inferMime,
  classifyMedia,
  type EndpointContext,
  type EndpointClient,
  type AiloConnectionConfig,
  type EnvMapping,
} from "@lmcl/ailo-endpoint-sdk";
import { join, basename } from "path";
import { EmailHandler } from "./email-handler.js";

const CONFIG_PORT = Number(process.env.CONFIG_PORT) || 19803;
const configPath = join(process.cwd(), "config.json");
const BLUEPRINT_URL =
  process.env.BLUEPRINT_EMAIL_URL ??
  "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/email-channel.blueprint.md";

interface EmailConfig {
  ailo: { wsUrl: string; apiKey: string; endpointId: string; displayName?: string };
  email: {
    imapHost: string; imapUser: string; imapPassword: string; imapPort: number;
    smtpHost?: string; smtpPort?: number; smtpUser?: string; smtpPassword?: string;
    tlsRejectUnauthorized?: boolean;
  };
}

const ENV_MAPPING: EnvMapping[] = [
  ...AILO_ENV_MAPPING,
  { envVar: "IMAP_HOST", configPath: "email.imapHost" },
  { envVar: "IMAP_USER", configPath: "email.imapUser" },
  { envVar: "IMAP_PASSWORD", configPath: "email.imapPassword" },
  { envVar: "IMAP_PORT", configPath: "email.imapPort" },
  { envVar: "SMTP_HOST", configPath: "email.smtpHost" },
  { envVar: "SMTP_PORT", configPath: "email.smtpPort" },
  { envVar: "SMTP_USER", configPath: "email.smtpUser" },
  { envVar: "SMTP_PASSWORD", configPath: "email.smtpPassword" },
  { envVar: "TLS_REJECT_UNAUTHORIZED", configPath: "email.tlsRejectUnauthorized" },
];

function loadConfig(): EmailConfig {
  const { merged } = mergeWithEnv<EmailConfig>(readConfig<EmailConfig>(configPath), ENV_MAPPING);
  return merged;
}

function getAiloConnection(cfg: EmailConfig): AiloConnectionConfig {
  return { url: cfg.ailo?.wsUrl ?? "", apiKey: cfg.ailo?.apiKey ?? "", endpointId: cfg.ailo?.endpointId ?? "", displayName: cfg.ailo?.displayName };
}

function hasValidEmailConfig(cfg: EmailConfig): boolean {
  return !!(cfg.email?.imapHost && cfg.email?.imapUser && cfg.email?.imapPassword);
}

const connectionState = { connected: false, endpointId: "", displayName: "邮件" };
let endpointCtxRef: EndpointContext | null = null;
let connectAttempt = 0;
let connectionPending = false;
let currentStop: (() => Promise<void>) | null = null;

async function applyConnection(overrides?: AiloConnectionConfig): Promise<void> {
  const cfg = loadConfig();
  const e = cfg.email;
  if (!e?.imapHost || !e?.imapUser || !e?.imapPassword) return;
  const ailo = overrides ?? getAiloConnection(cfg);
  if (!hasValidConfig(ailo)) return;
  if (connectionPending) return;

  connectionPending = true;
  try {
    connectAttempt = 0;
    const handler = new EmailHandler({
      imapHost: e.imapHost,
      imapPort: Number(e.imapPort) || 993,
      imapUser: e.imapUser,
      imapPassword: e.imapPassword,
      smtpHost: e.smtpHost || undefined,
      smtpPort: e.smtpPort ? Number(e.smtpPort) : undefined,
      smtpUser: e.smtpUser || undefined,
      smtpPassword: e.smtpPassword || undefined,
      tlsRejectUnauthorized: String(e.tlsRejectUnauthorized) !== "false",
    });

    const wrapper = {
      start: async (ctx: EndpointContext) => {
        connectionPending = false;
        endpointCtxRef = ctx;
        connectionState.connected = true;
        connectionState.endpointId = ailo.endpointId;
        connectionState.displayName = ailo.displayName ?? "邮件";
        await handler.start(ctx);
        console.log("[email] 邮件端点已启动");
      },
      stop: async () => {
        currentStop = null;
        connectionPending = false;
        endpointCtxRef = null;
        connectionState.connected = false;
        connectionState.endpointId = "";
        await handler.stop();
        console.log("[email] 邮件端点已停止");
      },
    };

    currentStop = () => wrapper.stop();
    runEndpoint({
      handler: wrapper,
      displayName: ailo.displayName ?? "邮件",
      caps: ["message", "tool_execute"],
      ailoWsUrl: ailo.url,
      ailoApiKey: ailo.apiKey,
      endpointId: ailo.endpointId,
      blueprints: [BLUEPRINT_URL],
      instructions: "邮件通道：chat_id 为发件人邮箱地址。",
      toolHandlers: {
        send: async (args: Record<string, unknown>) => {
          await handler.send({ to: args.to as string, cc: args.cc as string | undefined, bcc: args.bcc as string | undefined, subject: args.subject as string | undefined, body: args.body as string, html: args.html as string | undefined, attachments: args.attachments as any });
          return `邮件已发送至 ${args.to}`;
        },
        reply: async (args: Record<string, unknown>) => {
          await handler.reply({ uid: args.uid as number, folder: args.folder as string | undefined, body: args.body as string, html: args.html as string | undefined, attachments: args.attachments as any });
          return `已回复 uid=${args.uid}`;
        },
        forward: async (args: Record<string, unknown>) => {
          await handler.forward({ uid: args.uid as number, folder: args.folder as string | undefined, to: args.to as string, cc: args.cc as string | undefined, bcc: args.bcc as string | undefined, body: args.body as string | undefined });
          return `已转发至 ${args.to}`;
        },
        list: async (args: Record<string, unknown>) => {
          const items = await handler.list({ folder: args.folder as string | undefined, limit: args.limit as number | undefined, offset: args.offset as number | undefined, unreadOnly: args.unread_only as boolean | undefined });
          const lines = items.map((i: any) => `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`);
          return lines.length ? lines.join("\n") : "（无邮件）";
        },
        read: async (args: Record<string, unknown>) => {
          const d = await handler.read({ uid: args.uid as number, folder: args.folder as string | undefined });
          if (!d) throw new Error(`uid=${args.uid} 不存在`);
          const att = d.attachments.length ? `\n附件: ${d.attachments.map((a: any) => `${a.filename} (${a.size}B)`).join(", ")}` : "";
          return `from: ${d.from}\nto: ${d.to}\nsubject: ${d.subject}\ndate: ${d.date}\n\n${d.text ?? d.html ?? ""}${att}`;
        },
        search: async (args: Record<string, unknown>) => {
          const items = await handler.search({ query: args.query as string | undefined, from: args.from as string | undefined, to: args.to_search as string | undefined, subject: args.subject as string | undefined, since: args.since as string | undefined, until: args.until as string | undefined, folder: args.folder as string | undefined, limit: args.limit as number | undefined });
          const lines = items.map((i: any) => `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`);
          return lines.length ? lines.join("\n") : "（无匹配）";
        },
        mark_read: async (args: Record<string, unknown>) => {
          const uids = args.uids as number[];
          await handler.markRead({ uids, read: args.read as boolean, folder: args.folder as string | undefined });
          return `已标记 ${uids.length} 封为${args.read ? "已读" : "未读"}`;
        },
        move: async (args: Record<string, unknown>) => {
          const uids = args.uids as number[];
          await handler.move({ uids, folder: args.folder as string, fromFolder: args.from_folder as string | undefined });
          return `已移动 ${uids.length} 封到 ${args.folder}`;
        },
        delete: async (args: Record<string, unknown>) => {
          const uids = args.uids as number[];
          await handler.delete({ uids, folder: args.folder as string | undefined });
          return `已删除 ${uids.length} 封`;
        },
        get_attachment: async (args: Record<string, unknown>) => {
          const filename = args.filename as string;
          const localPath = await handler.downloadAttachment({ uid: args.uid as number, folder: args.folder as string | undefined, filename });
          if (!localPath) throw new Error(`附件 ${filename} 不存在`);
          const mime = inferMime(localPath);
          const mediaType = classifyMedia(mime);
          return [mediaPart(mediaType, { type: mediaType, path: localPath, mime, name: filename })];
        },
      },
      onConnectFailure: async (err: Error, client: EndpointClient) => {
        const latest = getAiloConnection(loadConfig());
        if (!hasValidConfig(latest)) { connectionPending = false; return; }
        const delay = backoffDelayMs(connectAttempt++);
        console.error(`[email] 连接失败，${(delay / 1000).toFixed(1)}s 后重试 (${err.message})`);
        await new Promise((r) => setTimeout(r, delay));
        await client.reconnect(undefined, { url: latest.url, apiKey: latest.apiKey, endpointId: latest.endpointId, displayName: latest.displayName });
      },
    });
  } catch (e) { connectionPending = false; throw e; }
}

async function main(): Promise<void> {
  startChannelConfigServer({
    channelName: "邮件",
    defaultPort: CONFIG_PORT,
    configPath,
    platformFields: [
      { key: "email.imapHost", label: "IMAP 主机", envVar: "IMAP_HOST", placeholder: "imap.example.com", required: true },
      { key: "email.imapUser", label: "IMAP 用户名", envVar: "IMAP_USER", placeholder: "user@example.com", required: true },
      { key: "email.imapPassword", label: "IMAP 密码", envVar: "IMAP_PASSWORD", type: "password", required: true },
      { key: "email.imapPort", label: "IMAP 端口", envVar: "IMAP_PORT", type: "number", placeholder: "993" },
      { key: "email.smtpHost", label: "SMTP 主机（可选）", envVar: "SMTP_HOST", placeholder: "smtp.example.com" },
      { key: "email.smtpPort", label: "SMTP 端口（可选）", envVar: "SMTP_PORT", type: "number", placeholder: "465" },
      { key: "email.smtpUser", label: "SMTP 用户名（可选）", envVar: "SMTP_USER" },
      { key: "email.smtpPassword", label: "SMTP 密码（可选）", envVar: "SMTP_PASSWORD", type: "password" },
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
  if (hasValidEmailConfig(cfg) && hasValidConfig(getAiloConnection(cfg))) {
    await applyConnection();
  } else {
    console.log("[email] 未检测到完整配置，请打开配置页填写邮件与 Ailo 连接信息并保存。");
    console.log(`[email] 配置界面: http://127.0.0.1:${CONFIG_PORT}`);
  }
}

main().catch((e) => { console.error("[email] 启动失败:", e); process.exit(1); });
