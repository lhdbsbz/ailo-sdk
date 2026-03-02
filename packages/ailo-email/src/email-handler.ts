/**
 * 邮件通道 Handler：ImapFlow 收信/读信/搜索/组织 + nodemailer 发信/回复/转发
 *
 * 核心改进（vs imap callback 版）：
 * - IMAP IDLE：零延迟推送，取代 60s 轮询
 * - 自动重连：指数退避，断线自愈
 * - UIDVALIDITY 追踪：邮箱重建时正确重置
 * - getMailboxLock 互斥：工具操作与 IDLE 安全共存
 * - 全 async/await，无 callback 竞态
 */
import { ImapFlow } from "imapflow";
import type { FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import fs from "fs";
import os from "os";
import path from "path";
import { type EndpointHandler, type AcceptMessage, type EndpointContext, type ContextTag, textPart, mediaPart } from "@lmcl/ailo-endpoint-sdk";
import { getWorkDir } from "@lmcl/ailo-endpoint-sdk";

export type EmailConfig = {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  tls?: boolean;
  tlsRejectUnauthorized?: boolean;
};

export type EmailListItem = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  isRead: boolean;
};

export type EmailDetail = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  text?: string;
  html?: string;
  attachments: { filename: string; contentType: string; size: number }[];
};

type Checkpoint = {
  lastUid: number;
  uidValidity: number;
};

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export class EmailHandler implements EndpointHandler {
  private config: EmailConfig;
  private ctx: EndpointContext | null = null;
  private imap: ImapFlow | null = null;
  private transporter: nodemailer.Transporter | null = null;
  private stopped = false;
  private lastUid = 0;
  private uidValidity = 0;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  async start(ctx: EndpointContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    this.imapLoop().catch((err: unknown) => console.error("[email] fatal imapLoop error:", err));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.imap) {
      this.imap.close();
      this.imap = null;
    }
    this.transporter = null;
  }

  // ── IMAP 主循环：连接 → IDLE → 断线重连 ──

  private async imapLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.connectImap();
        attempt = 0;
        this.ctx?.reportHealth("connected");
        await this.idleLoop();
      } catch (err) {
        if (this.stopped) break;
        console.error("[email] IMAP error:", (err as Error).message);
        this.ctx?.reportHealth("error", (err as Error).message);
      }
      if (this.stopped) break;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt++;
      this.ctx?.reportHealth("reconnecting", `attempt ${attempt}, delay ${delay}ms`);
      console.error(`[email] IMAP reconnecting in ${delay}ms (attempt ${attempt})`);
      await this.sleep(delay);
    }
  }

  private async connectImap(): Promise<void> {
    if (this.imap) {
      try { this.imap.close(); } catch { /* ignore */ }
      this.imap = null;
    }
    this.imap = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      auth: { user: this.config.imapUser, pass: this.config.imapPassword },
      secure: this.config.tls ?? true,
      tls: { rejectUnauthorized: this.config.tlsRejectUnauthorized ?? true },
      logger: false,
    });
    await this.imap.connect();
    console.error(`[email] IMAP connected to ${this.config.imapHost}`);
    await this.restoreCheckpoint();
  }

  private async idleLoop(): Promise<void> {
    while (this.imap?.usable && !this.stopped) {
      const lock = await this.imap.getMailboxLock("INBOX");
      try {
        const box = this.imap.mailbox;
        const validity = box ? Number(box.uidValidity ?? 0) : 0;
        if (validity && validity !== this.uidValidity) {
          if (this.uidValidity !== 0) {
            console.error(`[email] UIDVALIDITY changed (${this.uidValidity} → ${validity}), resetting lastUid`);
          }
          this.uidValidity = validity;
          this.lastUid = 0;
        }
        await this.fetchNewMessages();
      } finally {
        lock.release();
      }
      try {
        await this.imap.idle();
      } catch {
        // IDLE interrupted (e.g. by a tool operation) — loop back
      }
    }
  }

  private async fetchNewMessages(): Promise<void> {
    if (!this.imap?.usable || !this.ctx) return;
    const range = `${this.lastUid + 1}:*`;
    let maxUid = this.lastUid;
    let count = 0;

    try {
      for await (const msg of this.imap.fetch(range, { uid: true, source: true }, { uid: true })) {
        if (!msg || msg.uid <= this.lastUid) continue;
        if (msg.uid > maxUid) maxUid = msg.uid;
        if (!msg.source) continue;
        count++;
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          await this.emitMessage(parsed);
        } catch (err) {
          console.error(`[email] parse uid=${msg.uid} failed:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error("[email] fetch error:", (err as Error).message);
    }

    if (maxUid > this.lastUid) {
      this.lastUid = maxUid;
      await this.saveCheckpoint();
      if (count > 0) console.error(`[email] processed ${count} new message(s), lastUid=${this.lastUid}`);
    }
  }

  // ── Checkpoint ──

  private async saveCheckpoint(): Promise<void> {
    const cp: Checkpoint = { lastUid: this.lastUid, uidValidity: this.uidValidity };
    try {
      await this.ctx!.storage.setData("checkpoint", JSON.stringify(cp));
    } catch (err) {
      console.error("[email] save checkpoint failed:", (err as Error).message);
    }
  }

  private async restoreCheckpoint(): Promise<void> {
    try {
      const raw = await this.ctx!.storage.getData("checkpoint");
      if (!raw) {
        // 兼容旧版 last_uid 格式
        const legacy = await this.ctx!.storage.getData("last_uid");
        if (legacy) {
          this.lastUid = parseInt(legacy, 10) || 0;
          console.error(`[email] migrated legacy last_uid=${this.lastUid}`);
          return;
        }
        return;
      }
      const cp = JSON.parse(raw) as Partial<Checkpoint>;
      this.lastUid = cp.lastUid ?? 0;
      this.uidValidity = cp.uidValidity ?? 0;
      console.error(`[email] restored checkpoint: lastUid=${this.lastUid}, uidValidity=${this.uidValidity}`);
    } catch (err) {
      console.error("[email] restore checkpoint failed:", (err as Error).message);
    }
  }

  // ── 消息推送 ──

  private async emitMessage(parsed: ParsedMail): Promise<void> {
    if (!this.ctx) return;
    const from = parsed.from?.value?.[0];
    const fromAddr = from?.address ?? "unknown";
    const fromName = from?.name ?? fromAddr;
    const subject = parsed.subject ?? "（无主题）";
    const text = parsed.text ?? (typeof parsed.html === "string" ? parsed.html : "") ?? "";
    const attachments = await this.saveAttachmentsToWorkdir(parsed);

    const contextTags: ContextTag[] = [
      { kind: "conv_type", value: "私聊", groupWith: true },
      { kind: "chat_id", value: fromAddr, groupWith: true, passToTool: true },
      { kind: "participant", value: fromName, groupWith: false },
      { kind: "sender_id", value: fromAddr, groupWith: false, passToTool: true },
    ];

    const content: AcceptMessage["content"] = [];
    const bodyText = `[主题: ${subject}]\n\n${text}`.trim();
    if (bodyText) content.push(textPart(bodyText));
    for (const a of attachments) {
      const typ = (a.type ?? "file").toLowerCase();
      const mediaType = ["image", "audio", "video", "pdf", "file"].includes(typ) ? typ : "file";
      content.push(
        mediaPart(mediaType as "image" | "audio" | "video" | "pdf" | "file", {
          type: a.type ?? "file",
          path: a.path,
          mime: a.mime,
          name: a.name,
        })
      );
    }

    try {
      await this.ctx.accept({ content, contextTags });
    } catch (err) {
      console.error("[email] accept failed:", (err as Error).message);
    }
  }

  // ── IMAP 工具操作（mailbox lock 保证与 IDLE 互斥）──

  private async withMailbox<T>(folder: string, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
    if (!this.imap?.usable) throw new Error("IMAP 未连接");
    const lock = await this.imap.getMailboxLock(folder);
    try {
      return await fn(this.imap);
    } finally {
      lock.release();
    }
  }

  async list(opts: {
    folder?: string;
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
  }): Promise<EmailListItem[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);

    return this.withMailbox(folder, async (imap) => {
      const criteria = opts.unreadOnly ? { seen: false } : {};
      const result = await imap.search(criteria, { uid: true });
      const uids = Array.isArray(result) ? result : [];
      if (uids.length === 0) return [];

      const sorted = [...uids].sort((a, b) => b - a);
      const slice = sorted.slice(offset, offset + limit);
      if (slice.length === 0) return [];

      const items: EmailListItem[] = [];
      for await (const msg of imap.fetch(slice.join(","), { uid: true, envelope: true, flags: true }, { uid: true })) {
        const from = msg.envelope?.from?.[0];
        items.push({
          uid: msg.uid,
          from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "",
          to: msg.envelope?.to?.map((a: { address?: string }) => a.address).filter(Boolean).join(", ") ?? "",
          subject: msg.envelope?.subject ?? "（无主题）",
          date: msg.envelope?.date?.toISOString() ?? "",
          isRead: msg.flags?.has("\\Seen") ?? false,
        });
      }
      return items.sort((a, b) => b.uid - a.uid);
    });
  }

  async read(opts: { uid: number; folder?: string }): Promise<EmailDetail | null> {
    const folder = opts.folder ?? "INBOX";
    return this.withMailbox(folder, async (imap) => {
      let raw: FetchMessageObject | false;
      try {
        raw = await imap.fetchOne(String(opts.uid), { uid: true, source: true }, { uid: true });
      } catch {
        return null;
      }
      if (!raw || !raw.source) return null;

      const parsed = await simpleParser(raw.source as Buffer);
      await imap.messageFlagsAdd(String(opts.uid), ["\\Seen"], { uid: true }).catch(() => {});

      const from = parsed.from?.value?.[0];
      const toObj = parsed.to;
      const toAddrs = toObj ? (Array.isArray(toObj) ? toObj : [toObj]).flatMap((t) => t.value.map((v) => v.address)).filter(Boolean).join(", ") : "";
      return {
        uid: opts.uid,
        from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "",
        to: toAddrs,
        subject: parsed.subject ?? "（无主题）",
        date: parsed.date?.toISOString() ?? "",
        text: parsed.text ?? undefined,
        html: typeof parsed.html === "string" ? parsed.html : undefined,
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? "attachment",
          contentType: a.contentType ?? "application/octet-stream",
          size: a.size ?? 0,
        })),
      };
    });
  }

  async search(opts: {
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    since?: string;
    until?: string;
    folder?: string;
    limit?: number;
  }): Promise<EmailListItem[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

    return this.withMailbox(folder, async (imap) => {
      const criteria: Record<string, unknown> = {};
      if (opts.from) criteria.from = opts.from;
      if (opts.to) criteria.to = opts.to;
      if (opts.subject) criteria.subject = opts.subject;
      if (opts.since) criteria.since = new Date(opts.since);
      if (opts.until) criteria.before = new Date(opts.until);
      if (opts.query) criteria.body = opts.query;

      const searchResult = await imap.search(criteria, { uid: true });
      const uids = Array.isArray(searchResult) ? searchResult : [];
      const sorted = [...uids].sort((a, b) => b - a).slice(0, limit);
      if (sorted.length === 0) return [];

      const items: EmailListItem[] = [];
      for await (const msg of imap.fetch(sorted.join(","), { uid: true, envelope: true, flags: true }, { uid: true })) {
        const from = msg.envelope?.from?.[0];
        items.push({
          uid: msg.uid,
          from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "",
          to: msg.envelope?.to?.map((a: { address?: string }) => a.address).filter(Boolean).join(", ") ?? "",
          subject: msg.envelope?.subject ?? "（无主题）",
          date: msg.envelope?.date?.toISOString() ?? "",
          isRead: msg.flags?.has("\\Seen") ?? false,
        });
      }
      return items.sort((a, b) => b.uid - a.uid);
    });
  }

  async markRead(opts: { uids: number[]; read: boolean; folder?: string }): Promise<void> {
    const uids = opts.uids.slice(0, 500);
    if (uids.length === 0) return;
    await this.withMailbox(opts.folder ?? "INBOX", async (imap) => {
      const range = uids.join(",");
      if (opts.read) {
        await imap.messageFlagsAdd(range, ["\\Seen"], { uid: true });
      } else {
        await imap.messageFlagsRemove(range, ["\\Seen"], { uid: true });
      }
    });
  }

  async move(opts: { uids: number[]; folder: string; fromFolder?: string }): Promise<void> {
    const uids = opts.uids.slice(0, 500);
    if (uids.length === 0) return;
    await this.withMailbox(opts.fromFolder ?? "INBOX", async (imap) => {
      await imap.messageMove(uids.join(","), opts.folder, { uid: true });
    });
  }

  async delete(opts: { uids: number[]; folder?: string }): Promise<void> {
    const uids = opts.uids.slice(0, 500);
    if (uids.length === 0) return;
    await this.withMailbox(opts.folder ?? "INBOX", async (imap) => {
      await imap.messageDelete(uids.join(","), { uid: true });
    });
  }

  async downloadAttachment(opts: { uid: number; folder?: string; filename: string }): Promise<string | null> {
    return this.withMailbox(opts.folder ?? "INBOX", async (imap) => {
      let raw: FetchMessageObject | false;
      try {
        raw = await imap.fetchOne(String(opts.uid), { uid: true, source: true }, { uid: true });
      } catch {
        return null;
      }
      if (!raw || !raw.source) return null;

      const parsed = await simpleParser(raw.source as Buffer);
      const att = parsed.attachments?.find((a) => (a.filename ?? "") === opts.filename);
      if (!att?.content || !Buffer.isBuffer(att.content)) return null;

      const workDir = getWorkDir() ?? os.tmpdir();
      const outDir = path.join(workDir, "blobs");
      await fs.promises.mkdir(outDir, { recursive: true });
      const safeName = (att.filename ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      const outPath = path.join(outDir, `${Date.now()}_${safeName}`);
      await fs.promises.writeFile(outPath, att.content);
      return outPath;
    });
  }

  // ── SMTP ──

  private getSmtpConfig() {
    const host = this.config.smtpHost
      ?? this.config.imapHost.replace(/^imap\./, "smtp.");
    return {
      host,
      port: this.config.smtpPort ?? 465,
      user: this.config.smtpUser ?? this.config.imapUser,
      pass: this.config.smtpPassword ?? this.config.imapPassword,
    };
  }

  private ensureTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      const smtp = this.getSmtpConfig();
      this.transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.pass },
      });
    }
    return this.transporter;
  }

  async send(opts: {
    to: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body: string;
    html?: string;
    attachments?: { filename: string; content: string; contentType?: string }[];
  }): Promise<void> {
    await this.ensureTransporter().sendMail({
      from: this.config.imapUser,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject ?? "（无主题）",
      text: opts.body,
      html: opts.html,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
  }

  async reply(opts: {
    uid: number;
    folder?: string;
    body: string;
    html?: string;
    attachments?: { filename: string; content: string; contentType?: string }[];
  }): Promise<void> {
    const parsed = await this.withMailbox(opts.folder ?? "INBOX", async (imap) => {
      const raw = await imap.fetchOne(String(opts.uid), { uid: true, source: true }, { uid: true });
      if (!raw || !raw.source) throw new Error(`邮件 uid=${opts.uid} 不存在`);
      return simpleParser(raw.source as Buffer);
    });

    const to = parsed.from?.value?.[0]?.address ?? "";
    const subj = parsed.subject?.startsWith("Re:") ? parsed.subject : `Re: ${parsed.subject ?? ""}`;
    const inReplyTo = parsed.messageId;
    const refs = Array.isArray(parsed.references)
      ? parsed.references.join(" ")
      : (parsed.references ?? inReplyTo ?? "");

    await this.ensureTransporter().sendMail({
      from: this.config.imapUser,
      to,
      subject: subj,
      text: opts.body,
      html: opts.html,
      inReplyTo,
      references: refs,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
  }

  async forward(opts: {
    uid: number;
    folder?: string;
    to: string;
    cc?: string;
    bcc?: string;
    body?: string;
  }): Promise<void> {
    const parsed = await this.withMailbox(opts.folder ?? "INBOX", async (imap) => {
      const raw = await imap.fetchOne(String(opts.uid), { uid: true, source: true }, { uid: true });
      if (!raw || !raw.source) throw new Error(`邮件 uid=${opts.uid} 不存在`);
      return simpleParser(raw.source as Buffer);
    });

    const subj = parsed.subject?.startsWith("Fwd:") ? parsed.subject : `Fwd: ${parsed.subject ?? ""}`;
    const fwdText = parsed.text ?? (typeof parsed.html === "string" ? parsed.html : "");

    await this.ensureTransporter().sendMail({
      from: this.config.imapUser,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: subj,
      text: opts.body ? `${opts.body}\n\n--- 转发内容 ---\n${fwdText}` : fwdText,
      html: opts.body
        ? `<p>${opts.body.replace(/\n/g, "<br>")}</p><hr>${typeof parsed.html === "string" ? parsed.html : ""}`
        : (typeof parsed.html === "string" ? parsed.html : undefined),
    });
  }

  async sendText(to: string, text: string, subject?: string): Promise<void> {
    await this.send({ to, body: text, subject });
  }

  // ── Helpers ──

  private async saveAttachmentsToWorkdir(
    parsed: ParsedMail
  ): Promise<Array<{ type: string; path: string; mime?: string; name?: string }>> {
    if (!parsed.attachments?.length) return [];
    const workDir = getWorkDir();
    if (!workDir) return [];
    const blobsDir = path.join(workDir, "blobs");
    try {
      await fs.promises.mkdir(blobsDir, { recursive: true });
    } catch {
      return [];
    }

    const out: Array<{ type: string; path: string; mime?: string; name?: string }> = [];
    const ts = Date.now();
    for (let i = 0; i < parsed.attachments.length; i++) {
      const a = parsed.attachments[i];
      if (!a?.content || !Buffer.isBuffer(a.content)) continue;
      const base = (a.filename ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const ext = path.extname(base) || "";
      const stem = path.basename(base, ext) || "attachment";
      const filename = `${stem}_${ts}_${i}${ext}`;
      const outPath = path.join(blobsDir, filename);
      try {
        await fs.promises.writeFile(outPath, a.content);
        const mime = a.contentType ?? "application/octet-stream";
        const type = mime.startsWith("image/") ? "image"
          : mime.startsWith("audio/") ? "audio"
          : mime.startsWith("video/") ? "video"
          : "file";
        out.push({ type, path: outPath, mime, name: a.filename ?? filename });
      } catch {
        // skip this attachment on write failure
      }
    }
    return out;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
