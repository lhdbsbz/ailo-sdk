import {
  type EndpointHandler,
  type AcceptMessage,
  type EndpointContext,
  type EndpointStorage,
  type ContextTag,
  textPart,
} from "@lmcl/ailo-endpoint-sdk";
import {
  type DingTalkConfig,
  type DingTalkBotMessage,
  STALE_MESSAGE_THRESHOLD_MS,
} from "./dingtalk-types.js";
import { createChannelLogger, errMsg } from "./utils.js";

export type { DingTalkConfig } from "./dingtalk-types.js";

export class DingTalkHandler implements EndpointHandler {
  private ctx: EndpointContext | null = null;
  private client: any = null;

  constructor(private config: DingTalkConfig) {}

  private get storage(): EndpointStorage | null {
    return this.ctx?.storage ?? null;
  }

  private _log = createChannelLogger("dingtalk", () => this.ctx);

  private static readonly WEBHOOK_STORE_KEY = "session_webhooks";

  private async saveWebhook(sessionKey: string, webhook: string, expiresAt: number): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.getData(DingTalkHandler.WEBHOOK_STORE_KEY);
      const store: Record<string, { url: string; exp: number }> = raw ? JSON.parse(raw) : {};
      const now = Date.now();
      for (const [k, v] of Object.entries(store)) {
        if (v.exp < now) delete store[k];
      }
      store[sessionKey] = { url: webhook, exp: expiresAt };
      await this.storage.setData(DingTalkHandler.WEBHOOK_STORE_KEY, JSON.stringify(store));
    } catch (err) {
      this._log("warn", "保存 webhook 失败", { err: String(err) });
    }
  }

  private async getWebhook(sessionKey: string): Promise<string | null> {
    if (!this.storage) return null;
    try {
      const raw = await this.storage.getData(DingTalkHandler.WEBHOOK_STORE_KEY);
      if (!raw) return null;
      const store: Record<string, { url: string; exp: number }> = JSON.parse(raw);
      const entry = store[sessionKey];
      if (!entry) return null;
      if (entry.exp < Date.now()) return null;
      return entry.url;
    } catch {
      return null;
    }
  }

  private sessionKeyFromMessage(msg: DingTalkBotMessage): string {
    if (msg.conversationType === "2" && msg.conversationId) {
      return `grp:${msg.conversationId.slice(-16)}`;
    }
    return `p2p:${msg.senderStaffId || msg.senderNick}`;
  }

  private acceptMessage(msg: AcceptMessage): void {
    if (!this.ctx) return;
    this.ctx.accept(msg).catch((err: unknown) => this._log("error", "accept failed", { err: String(err) }));
  }

  private buildAcceptMessage(opts: {
    chatId: string;
    text: string;
    chatType: "群聊" | "私聊";
    senderId?: string;
    senderName?: string;
    chatName?: string;
  }): AcceptMessage {
    const { chatId, text, chatType, senderId = "", senderName = "", chatName } = opts;
    const isPrivate = chatType === "私聊";

    const tags: ContextTag[] = [
      { kind: "channel", value: "dingtalk", groupWith: true },
      { kind: "conv_type", value: chatType, groupWith: false },
      { kind: "chat_id", value: chatId, groupWith: true, passToTool: true },
    ];

    if (!isPrivate && chatName) {
      tags.push({ kind: "group", value: chatName, groupWith: false });
    }

    if (senderName) {
      tags.push({ kind: "participant", value: senderName, groupWith: false });
    }

    if (senderId) {
      tags.push({ kind: "sender_id", value: senderId, groupWith: false, passToTool: true });
    }

    const content = [];
    if (text) content.push(textPart(text));
    return { content, contextTags: tags };
  }

  async start(ctx: EndpointContext): Promise<void> {
    this.ctx = ctx;

    const { DWClient, TOPIC_ROBOT, EventAck } = await import("dingtalk-stream");

    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    this.client = client;

    const onBotMessage = async (event: { data: string }) => {
      try {
        const msg = JSON.parse(event.data) as DingTalkBotMessage;
        const text = (msg.text?.content ?? "").trim();
        const isGroup = msg.conversationType === "2";
        const chatType = isGroup ? "群聊" : "私聊";

        const sessionKey = this.sessionKeyFromMessage(msg);
        const chatId = sessionKey;

        if (msg.createAt && Date.now() - msg.createAt > STALE_MESSAGE_THRESHOLD_MS) {
          this._log("info", `dropped stale message ${msg.msgId}`, {
            create_time: msg.createAt,
            age_min: Math.round((Date.now() - msg.createAt) / 60000),
          });
          return { status: EventAck.SUCCESS, message: "stale" };
        }

        if (msg.sessionWebhook) {
          await this.saveWebhook(sessionKey, msg.sessionWebhook, msg.sessionWebhookExpiredTime);
        }

        this._log("debug", `received ${msg.msgtype} ${chatType} from ${msg.senderNick}`, {
          conversationId: msg.conversationId,
          text_len: text.length,
        });

        if (!text) {
          this._log("debug", `skipped empty message ${msg.msgId}`);
          return { status: EventAck.SUCCESS, message: "empty" };
        }

        this.acceptMessage(
          this.buildAcceptMessage({
            chatId,
            text,
            chatType,
            senderId: msg.senderStaffId,
            senderName: msg.senderNick,
            chatName: isGroup ? (msg.conversationTitle || undefined) : undefined,
          }),
        );
      } catch (err) {
        this._log("error", "处理钉钉消息失败", { err: String(err) });
      }

      return { status: EventAck.SUCCESS, message: "OK" };
    };

    client.registerCallbackListener(TOPIC_ROBOT, onBotMessage).connect();
    this._log("info", "钉钉 Stream 连接已建立");
    ctx.reportHealth("connected");
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!text?.trim()) return;

    const webhook = await this.getWebhook(chatId);
    if (!webhook) {
      this._log("warn", `无法发送消息到 ${chatId}：sessionWebhook 不存在或已过期`);
      throw new Error(`sessionWebhook 不存在或已过期 (chatId=${chatId})`);
    }

    const isMarkdown = /[#*`\[\]|]/.test(text);
    const body = isMarkdown
      ? { msgtype: "markdown", markdown: { title: "回复", text } }
      : { msgtype: "text", text: { content: text } };

    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this._log("error", `发送消息失败: HTTP ${res.status}`, { detail });
      throw new Error(`钉钉发送失败: HTTP ${res.status}`);
    }

    this._log("debug", `消息已发送到 ${chatId}`);
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        if (typeof this.client.disconnect === "function") this.client.disconnect();
      } catch { /* best-effort */ }
      this.client = null;
    }
    this.ctx = null;
  }
}
