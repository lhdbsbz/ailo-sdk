#!/usr/bin/env node
import { runEndpoint } from "@lmcl/ailo-endpoint-sdk";
import "dotenv/config";
import { EmailHandler } from "./email-handler.js";

const IMAP_HOST = process.env.IMAP_HOST ?? "";
const IMAP_USER = process.env.IMAP_USER ?? "";
const IMAP_PASSWORD = process.env.IMAP_PASSWORD ?? "";
const IMAP_PORT = parseInt(process.env.IMAP_PORT ?? "993", 10);

if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
  console.error("Missing IMAP_HOST, IMAP_USER or IMAP_PASSWORD");
  process.exit(1);
}

const handler = new EmailHandler({
  imapHost: IMAP_HOST,
  imapPort: IMAP_PORT,
  imapUser: IMAP_USER,
  imapPassword: IMAP_PASSWORD,
  smtpHost: process.env.SMTP_HOST || undefined,
  smtpPort: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
  smtpUser: process.env.SMTP_USER || undefined,
  smtpPassword: process.env.SMTP_PASSWORD || undefined,
  tlsRejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== "false",
});

runEndpoint({
  handler,
  displayName: "邮件",
  caps: ["message", "tool_execute"],
  blueprints: [
    process.env.BLUEPRINT_EMAIL_URL ??
      "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/email-channel.blueprint.md",
  ],
  instructions: "邮件通道：chat_id 为发件人邮箱地址。",
  toolHandlers: {
    send: async (args: Record<string, unknown>) => {
      await handler.send({
        to: args.to as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
        subject: args.subject as string | undefined,
        body: args.body as string,
        html: args.html as string | undefined,
        attachments: args.attachments as any,
      });
      return `邮件已发送至 ${args.to}`;
    },
    reply: async (args: Record<string, unknown>) => {
      await handler.reply({
        uid: args.uid as number,
        folder: args.folder as string | undefined,
        body: args.body as string,
        html: args.html as string | undefined,
        attachments: args.attachments as any,
      });
      return `已回复 uid=${args.uid}`;
    },
    forward: async (args: Record<string, unknown>) => {
      await handler.forward({
        uid: args.uid as number,
        folder: args.folder as string | undefined,
        to: args.to as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
        body: args.body as string | undefined,
      });
      return `已转发至 ${args.to}`;
    },
    list: async (args: Record<string, unknown>) => {
      const items = await handler.list({
        folder: args.folder as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
        unreadOnly: args.unread_only as boolean | undefined,
      });
      const lines = items.map(
        (i: any) => `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`
      );
      return lines.length ? lines.join("\n") : "（无邮件）";
    },
    read: async (args: Record<string, unknown>) => {
      const d = await handler.read({ uid: args.uid as number, folder: args.folder as string | undefined });
      if (!d) throw new Error(`uid=${args.uid} 不存在`);
      const att = d.attachments.length
        ? `\n附件: ${d.attachments.map((a: any) => `${a.filename} (${a.size}B)`).join(", ")}`
        : "";
      return `from: ${d.from}\nto: ${d.to}\nsubject: ${d.subject}\ndate: ${d.date}\n\n${d.text ?? d.html ?? ""}${att}`;
    },
    search: async (args: Record<string, unknown>) => {
      const items = await handler.search({
        query: args.query as string | undefined,
        from: args.from as string | undefined,
        to: args.to_search as string | undefined,
        subject: args.subject as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        folder: args.folder as string | undefined,
        limit: args.limit as number | undefined,
      });
      const lines = items.map(
        (i: any) => `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`
      );
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
      const b64 = await handler.getAttachment({
        uid: args.uid as number,
        folder: args.folder as string | undefined,
        filename: args.filename as string,
      });
      if (!b64) throw new Error(`附件 ${args.filename} 不存在`);
      return `base64:${b64}`;
    },
  },
});
