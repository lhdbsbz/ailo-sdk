import {
  type EndpointHandler,
  type AcceptMessage,
  type EndpointContext,
  type ContextTag,
  textPart,
  mediaPart,
} from "@lmcl/ailo-endpoint-sdk";
import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";

export interface DiscordConfig {
  botToken: string;
  httpProxy?: string;
}

const MAX_DISCORD_MSG_LENGTH = 2000;

export class DiscordHandler implements EndpointHandler {
  private ctx: EndpointContext | null = null;
  private client: Client | null = null;
  private config: DiscordConfig;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  private _log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    if (this.ctx?.log) {
      this.ctx.log(level, message, data);
    } else {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
      fn(`[discord] ${message}`, data ?? "");
    }
  }

  private acceptMessage(msg: AcceptMessage): void {
    if (!this.ctx) return;
    this.ctx.accept(msg).catch((err: unknown) => this._log("error", "accept failed", { err: String(err) }));
  }

  private buildAcceptMessage(opts: {
    chatId: string;
    text: string;
    chatType: "频道" | "私聊";
    senderId: string;
    senderName: string;
    guildName?: string;
    channelName?: string;
    msgId: string;
    attachments?: Array<{ type: string; url: string; name: string }>;
  }): AcceptMessage {
    const { chatId, text, chatType, senderId, senderName, guildName, channelName, msgId, attachments } = opts;

    const tags: ContextTag[] = [
      { kind: "conv_type", value: chatType, groupWith: false },
      { kind: "chat_id", value: chatId, groupWith: true, passToTool: true },
    ];

    if (guildName) {
      tags.push({ kind: "group", value: guildName, groupWith: false });
    }
    if (channelName) {
      tags.push({ kind: "channel_name", value: channelName, groupWith: false });
    }
    if (senderName) {
      tags.push({ kind: "participant", value: senderName, groupWith: false });
    }
    if (senderId) {
      tags.push({ kind: "sender_id", value: senderId, groupWith: false, passToTool: true });
    }
    if (msgId) {
      tags.push({ kind: "msg_id", value: msgId, groupWith: false, passToTool: true });
    }

    const content = [];
    if (text) content.push(textPart(text));
    for (const att of attachments ?? []) {
      const t = att.type.toLowerCase();
      const mediaType = t.startsWith("image") ? "image" : t.startsWith("video") ? "video" : t.startsWith("audio") ? "audio" : "file";
      content.push(
        mediaPart(mediaType as "image" | "audio" | "video" | "file", {
          type: mediaType,
          url: att.url,
          name: att.name,
        }),
      );
    }

    return { content, contextTags: tags };
  }

  async start(ctx: EndpointContext): Promise<void> {
    this.ctx = ctx;

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      ...(this.config.httpProxy ? { rest: { agent: undefined } } : {}),
    });
    this.client = client;

    client.on("messageCreate", (message: Message) => {
      if (message.author.bot) return;

      const text = (message.content ?? "").trim();
      const isDM = !message.guild;
      const chatId = isDM ? `dm:${message.author.id}` : `ch:${message.channelId}`;

      const attachments = message.attachments.map((att) => {
        const ctype = (att.contentType ?? "").toLowerCase();
        return { type: ctype || "file", url: att.url, name: att.name ?? "file" };
      });

      if (!text && attachments.length === 0) return;

      this.acceptMessage(
        this.buildAcceptMessage({
          chatId,
          text,
          chatType: isDM ? "私聊" : "频道",
          senderId: message.author.id,
          senderName: message.author.displayName ?? message.author.username,
          guildName: message.guild?.name,
          channelName: (message.channel as TextChannel).name,
          msgId: message.id,
          attachments,
        }),
      );
    });

    client.on("ready", () => {
      this._log("info", `Discord Bot 已上线: ${client.user?.tag}`);
      ctx.reportHealth("connected");
    });

    client.on("error", (err: Error) => {
      this._log("error", "Discord client error", { err: err.message });
    });

    await client.login(this.config.botToken);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!text?.trim()) return;
    if (!this.client?.isReady()) throw new Error("Discord client 未就绪");

    const [kind, id] = chatId.split(":", 2);
    if (!kind || !id) throw new Error(`无效的 chat_id 格式: ${chatId}`);

    const chunks = this.splitMessage(text);

    if (kind === "ch") {
      const channel = this.client.channels.cache.get(id) ?? (await this.client.channels.fetch(id));
      if (!channel || !("send" in channel)) throw new Error(`无法获取频道: ${id}`);
      for (const chunk of chunks) {
        await (channel as TextChannel).send(chunk);
      }
    } else if (kind === "dm") {
      const user = this.client.users.cache.get(id) ?? (await this.client.users.fetch(id));
      const dm = user.dmChannel ?? (await user.createDM());
      for (const chunk of chunks) {
        await dm.send(chunk);
      }
    } else {
      throw new Error(`不支持的 chat_id 类型: ${kind}`);
    }

    this._log("debug", `消息已发送到 ${chatId}`);
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_DISCORD_MSG_LENGTH) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_DISCORD_MSG_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_MSG_LENGTH);
      if (splitAt <= 0) splitAt = MAX_DISCORD_MSG_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.ctx = null;
  }
}
