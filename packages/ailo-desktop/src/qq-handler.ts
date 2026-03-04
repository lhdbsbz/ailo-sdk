import {
  type EndpointHandler,
  type AcceptMessage,
  type EndpointContext,
  type ContextTag,
  textPart,
} from "@lmcl/ailo-endpoint-sdk";
import { type QQConfig, type QQMessageEvent, type QQC2CMessageEvent, DEFAULT_API_BASE } from "./qq-types.js";
import { QQGatewayClient } from "./qq-ws.js";

export type { QQConfig } from "./qq-types.js";

export class QQHandler implements EndpointHandler {
  private ctx: EndpointContext | null = null;
  private gateway: QQGatewayClient | null = null;
  private lastMsgIdByChatId = new Map<string, string>();

  constructor(private config: QQConfig) {}

  private get apiBase(): string {
    return (this.config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  }

  private _log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    if (this.ctx?.log) {
      this.ctx.log(level, message, data);
    } else {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
      fn(`[qq] ${message}`, data ?? "");
    }
  }

  private acceptMessage(msg: AcceptMessage): void {
    if (!this.ctx) return;
    this.ctx.accept(msg).catch((err: unknown) => this._log("error", "accept failed", { err: String(err) }));
  }

  private buildAcceptMessage(opts: {
    chatId: string;
    text: string;
    chatType: "群聊" | "私聊" | "频道";
    senderId: string;
    senderName: string;
    msgId: string;
  }): AcceptMessage {
    const { chatId, text, chatType, senderId, senderName, msgId } = opts;

    const tags: ContextTag[] = [
      { kind: "channel", value: "QQ", groupWith: true },
      { kind: "conv_type", value: chatType, groupWith: false },
      { kind: "chat_id", value: chatId, groupWith: true, passToTool: true },
    ];

    if (senderName) {
      tags.push({ kind: "participant", value: senderName, groupWith: false });
    }

    if (senderId) {
      tags.push({ kind: "sender_id", value: senderId, groupWith: false, passToTool: true });
    }

    if (msgId) {
      tags.push({ kind: "msg_id", value: msgId, groupWith: false, passToTool: true });
    }

    return { content: [textPart(text)], contextTags: tags };
  }

  private stripAtPrefix(content: string): string {
    return content.replace(/<@!\d+>\s*/g, "").trim();
  }

  async start(ctx: EndpointContext): Promise<void> {
    this.ctx = ctx;

    const gateway = new QQGatewayClient(
      this.config,
      (event, data) => this.handleDispatch(event, data),
      (level, msg, d) => this._log(level as any, msg, d),
    );
    this.gateway = gateway;

    await gateway.connect();
    this._log("info", "QQ Bot Gateway 已连接");
    ctx.reportHealth("connected");
  }

  private handleDispatch(event: string, data: any): void {
    switch (event) {
      case "AT_MESSAGE_CREATE":
        this.handleGuildMessage(data as QQMessageEvent);
        break;
      case "PUBLIC_MESSAGES_DELETE":
        this._log("debug", "ignored message delete event");
        break;
      case "DIRECT_MESSAGE_CREATE":
        this.handleDirectMessage(data as QQMessageEvent);
        break;
      case "C2C_MESSAGE_CREATE":
        this.handleC2CMessage(data as QQC2CMessageEvent);
        break;
      case "GROUP_AT_MESSAGE_CREATE":
        this.handleGroupMessage(data as QQMessageEvent);
        break;
      default:
        this._log("debug", `unhandled event: ${event}`);
    }
  }

  private handleGuildMessage(msg: QQMessageEvent): void {
    if (msg.author?.bot) return;
    const text = this.stripAtPrefix(msg.content ?? "");
    if (!text) return;

    const chatId = `ch:${msg.channel_id}`;
    if (msg.id) this.lastMsgIdByChatId.set(chatId, msg.id);
    this.acceptMessage(
      this.buildAcceptMessage({
        chatId,
        text,
        chatType: "频道",
        senderId: msg.author?.id ?? "",
        senderName: msg.author?.username ?? "",
        msgId: msg.id,
      }),
    );
  }

  private handleDirectMessage(msg: QQMessageEvent): void {
    if (msg.author?.bot) return;
    const text = this.stripAtPrefix(msg.content ?? "");
    if (!text) return;

    const chatId = `dm:${msg.guild_id}`;
    if (msg.id) this.lastMsgIdByChatId.set(chatId, msg.id);
    this.acceptMessage(
      this.buildAcceptMessage({
        chatId,
        text,
        chatType: "私聊",
        senderId: msg.author?.id ?? "",
        senderName: msg.author?.username ?? "",
        msgId: msg.id,
      }),
    );
  }

  private handleC2CMessage(msg: QQC2CMessageEvent): void {
    const text = (msg.content ?? "").trim();
    if (!text) return;

    const userId = msg.author?.user_openid ?? msg.author?.id ?? "";
    const chatId = `c2c:${userId}`;
    if (msg.id) this.lastMsgIdByChatId.set(chatId, msg.id);
    this.acceptMessage(
      this.buildAcceptMessage({
        chatId,
        text,
        chatType: "私聊",
        senderId: userId,
        senderName: msg.author?.username ?? "",
        msgId: msg.id,
      }),
    );
  }

  private handleGroupMessage(msg: QQMessageEvent): void {
    if (msg.author?.bot) return;
    const text = this.stripAtPrefix(msg.content ?? "");
    if (!text) return;

    const chatId = `grp:${msg.group_openid ?? msg.group_id}`;
    if (msg.id) this.lastMsgIdByChatId.set(chatId, msg.id);
    this.acceptMessage(
      this.buildAcceptMessage({
        chatId,
        text,
        chatType: "群聊",
        senderId: msg.author?.id ?? "",
        senderName: msg.author?.username ?? "",
        msgId: msg.id,
      }),
    );
  }

  async sendText(chatId: string, text: string, msgId?: string): Promise<void> {
    if (!text?.trim()) return;
    if (!this.gateway) throw new Error("QQ Gateway 未连接");

    const token = this.gateway.getAccessToken();
    if (!token) throw new Error("QQ access token 不可用");

    const [kind, id] = chatId.split(":", 2);
    if (!kind || !id) throw new Error(`无效的 chat_id 格式: ${chatId}`);

    const resolvedMsgId = msgId || this.lastMsgIdByChatId.get(chatId);

    let url: string;
    let body: Record<string, unknown>;

    switch (kind) {
      case "ch":
        url = `${this.apiBase}/channels/${id}/messages`;
        body = { content: text, msg_id: resolvedMsgId || undefined };
        break;
      case "dm":
        url = `${this.apiBase}/dms/${id}/messages`;
        body = { content: text, msg_id: resolvedMsgId || undefined };
        break;
      case "c2c":
        url = `${this.apiBase}/v2/users/${id}/messages`;
        body = { content: text, msg_type: 0, msg_id: resolvedMsgId || undefined };
        break;
      case "grp":
        url = `${this.apiBase}/v2/groups/${id}/messages`;
        body = { content: text, msg_type: 0, msg_id: resolvedMsgId || undefined };
        break;
      default:
        throw new Error(`不支持的 chat_id 类型: ${kind}`);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this._log("error", `发送消息失败: HTTP ${res.status}`, { url, detail });
      throw new Error(`QQ 发送失败: HTTP ${res.status}`);
    }

    this._log("debug", `消息已发送到 ${chatId}`);
  }

  async stop(): Promise<void> {
    this.gateway?.close();
    this.gateway = null;
    this.ctx = null;
  }
}
