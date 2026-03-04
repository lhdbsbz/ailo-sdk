import {
  type EndpointHandler,
  type AcceptMessage,
  type EndpointContext,
  type ContextTag,
  textPart,
} from "@lmcl/ailo-endpoint-sdk";
import { type QQConfig, type QQMessageEvent, type QQC2CMessageEvent, DEFAULT_API_BASE } from "./qq-types.js";
import { QQGatewayClient } from "./qq-ws.js";
import { createChannelLogger, type LogLevel } from "./utils.js";

export type { QQConfig } from "./qq-types.js";

export class QQHandler implements EndpointHandler {
  private ctx: EndpointContext | null = null;
  private gateway: QQGatewayClient | null = null;
  private lastMsgIdByChatId = new Map<string, string>();

  constructor(private config: QQConfig) {}

  private get apiBase(): string {
    return (this.config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  }

  private _log = createChannelLogger("qq", () => this.ctx);

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
      (level, msg, d) => this._log(level as LogLevel, msg, d),
    );
    this.gateway = gateway;

    await gateway.connect();
    this._log("info", "QQ Bot Gateway 已连接");
    ctx.reportHealth("connected");
  }

  private handleIncomingMessage(
    msg: QQMessageEvent | QQC2CMessageEvent,
    opts: { prefix: string; chatType: "群聊" | "私聊" | "频道"; idField: string; stripAt: boolean },
  ): void {
    if ("author" in msg && (msg as QQMessageEvent).author?.bot) return;
    const text = opts.stripAt ? this.stripAtPrefix(msg.content ?? "") : (msg.content ?? "").trim();
    if (!text) return;

    const chatId = `${opts.prefix}:${opts.idField}`;
    if (msg.id) this.lastMsgIdByChatId.set(chatId, msg.id);
    this.acceptMessage(
      this.buildAcceptMessage({
        chatId,
        text,
        chatType: opts.chatType,
        senderId: (msg as any).author?.user_openid ?? (msg as any).author?.id ?? "",
        senderName: (msg as any).author?.username ?? "",
        msgId: msg.id,
      }),
    );
  }

  private handleDispatch(event: string, data: unknown): void {
    switch (event) {
      case "AT_MESSAGE_CREATE": {
        const msg = data as QQMessageEvent;
        this.handleIncomingMessage(msg, { prefix: "ch", chatType: "频道", idField: msg.channel_id ?? "", stripAt: true });
        break;
      }
      case "DIRECT_MESSAGE_CREATE": {
        const msg = data as QQMessageEvent;
        this.handleIncomingMessage(msg, { prefix: "dm", chatType: "私聊", idField: msg.guild_id ?? "", stripAt: true });
        break;
      }
      case "C2C_MESSAGE_CREATE": {
        const msg = data as QQC2CMessageEvent;
        const userId = msg.author?.user_openid ?? msg.author?.id ?? "";
        this.handleIncomingMessage(msg, { prefix: "c2c", chatType: "私聊", idField: userId, stripAt: false });
        break;
      }
      case "GROUP_AT_MESSAGE_CREATE": {
        const msg = data as QQMessageEvent;
        this.handleIncomingMessage(msg, { prefix: "grp", chatType: "群聊", idField: msg.group_openid ?? msg.group_id ?? "", stripAt: true });
        break;
      }
      case "PUBLIC_MESSAGES_DELETE":
        this._log("debug", "ignored message delete event");
        break;
      default:
        this._log("debug", `unhandled event: ${event}`);
    }
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
