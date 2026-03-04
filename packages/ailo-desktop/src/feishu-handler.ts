import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type EndpointHandler,
  type AcceptMessage,
  type EndpointContext,
  type EndpointStorage,
  type ContextTag,
  textPart,
  mediaPart,
} from "@lmcl/ailo-endpoint-sdk";
import { getWorkDir } from "@lmcl/ailo-endpoint-sdk";
import {
  type CacheEntry,
  type ChatInfo,
  type FeishuConfig,
  type FeishuMessageEvent,
  type FeishuMention,
  MEDIA_MESSAGE_CONFIG,
  STALE_MESSAGE_THRESHOLD_MS,
  type UserInfo,
} from "./feishu-types.js";
import type { FeishuAttachment } from "./feishu-types.js";
import {
  adaptMarkdownForFeishu,
  convertMarkdownTablesToCodeBlock,
  extractImageKeysFromPostContent,
  extractMentionElements,
  extractTextFromPostContent,
  streamToBuffer,
} from "./feishu-utils.js";
import { createChannelLogger, errMsg } from "./utils.js";

export type { FeishuConfig, FeishuAttachment } from "./feishu-types.js";

export class FeishuHandler implements EndpointHandler {
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private ctx: EndpointContext | null = null;

  private botOpenId: string = "";
  private mentionNameToId = new Map<string, string>();
  private userCache = new Map<string, CacheEntry<UserInfo>>();
  private chatCache = new Map<string, CacheEntry<ChatInfo>>();
  private externalUserCounter = 0;
  private externalUserLabels = new Map<string, string>();
  /** 串行化外部用户持久化，避免并发 getData→parse→setData 导致互相覆盖、数据丢失 */
  private externalUserSaveQueue: Promise<void> = Promise.resolve();
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // 缓存过期时间：24小时
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000;

  constructor(private config: FeishuConfig) {
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.fatal,
    });
  }

  private get storage(): EndpointStorage | null {
    return this.ctx?.storage ?? null;
  }

  private _log = createChannelLogger("feishu", () => this.ctx);

  /** 外部用户数据单 key：{ _counter, [userId]: label } */
  private static readonly EXTERNAL_USERS_KEY = "external_users";

  private loadExternalUserLabels(): void {
    if (!this.storage) return;
    this.storage
      .getData(FeishuHandler.EXTERNAL_USERS_KEY)
      .then((val: string | null) => {
        if (!val) return;
        try {
          const obj = JSON.parse(val) as { _counter?: number; [k: string]: unknown };
          if (typeof obj._counter === "number") this.externalUserCounter = obj._counter;
          for (const [k, v] of Object.entries(obj)) {
            if (k !== "_counter" && typeof v === "string") this.externalUserLabels.set(k, v);
          }
          this._log("info", `已加载外部用户映射: ${this.externalUserLabels.size} 条, counter=${this.externalUserCounter}`);
        } catch {
          this._log("warn", "解析外部用户数据失败，将从零开始");
        }
      })
      .catch((err: unknown) => {
        this._log("warn", "加载外部用户映射失败，将从零开始", { err: String(err) });
      });
  }

  private saveExternalUserLabel(userId: string, label: string): void {
    if (!this.storage) return;
    this.externalUserSaveQueue = this.externalUserSaveQueue
      .then(() =>
        this.storage!
          .getData(FeishuHandler.EXTERNAL_USERS_KEY)
          .then((val: string | null) => {
            const obj: Record<string, unknown> = val ? JSON.parse(val) : {};
            obj._counter = this.externalUserCounter;
            obj[userId] = label;
            return this.storage!.setData(FeishuHandler.EXTERNAL_USERS_KEY, JSON.stringify(obj));
          })
      )
      .catch((err: unknown) => {
        this._log("warn", "保存外部用户映射失败", { err: String(err) });
      });
  }

  private async fetchBotOpenId(): Promise<void> {
    try {
      const res = (await this.client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info/",
        data: {},
      })) as { data?: { bot?: { open_id?: string; user_id?: string } } };
      const bot = res.data?.bot;
      this.botOpenId = bot?.open_id ?? bot?.user_id ?? "";
      if (this.botOpenId) {
        this._log("info", `bot open_id: ${this.botOpenId}`);
      }
    } catch (err) {
      this._log("warn", "failed to fetch bot info", { err: String(err) });
    }
  }

  private resolveMentions(text: string, mentions?: FeishuMention[]): { text: string; mentionsSelf: boolean } {
    if (!mentions || mentions.length === 0) {
      return { text, mentionsSelf: false };
    }
    let mentionsSelf = false;
    let resolved = text;
    for (const m of mentions) {
      const openId = m.id?.open_id ?? m.id?.user_id ?? "";
      const displayName = m.name || openId;
      if (openId && this.botOpenId && openId === this.botOpenId) {
        mentionsSelf = true;
      }
      if (openId) {
        this.mentionNameToId.set(displayName, openId);
        resolved = resolved.replaceAll(m.key, `@${displayName}(${openId})`);
      } else {
        resolved = resolved.replaceAll(m.key, `@${displayName}`);
      }
    }
    return { text: resolved, mentionsSelf };
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
    mentionsSelf?: boolean;
    timestamp?: number;
    attachments?: Array<{ type: string; path?: string; url?: string; mime?: string; name?: string }>;
  }): AcceptMessage {
    const { chatId, text, chatType, senderId = "", senderName = "", chatName, attachments } = opts;
    const isPrivate = chatType === "私聊";

    const tags: ContextTag[] = [
      { kind: "channel", value: "飞书", groupWith: true },
      { kind: "conv_type", value: chatType, groupWith: false },
      { kind: "chat_id", value: chatId, groupWith: true, passToTool: true },
    ];

    if (!isPrivate) {
      const groupName = chatName || `群${chatId.slice(-8)}`;
      tags.push({ kind: "group", value: groupName, groupWith: false });
    }

    if (senderName) {
      tags.push({ kind: "participant", value: senderName, groupWith: false });
    }

    if (senderId) {
      tags.push({ kind: "sender_id", value: senderId, groupWith: false, passToTool: true });
    }

    const content = [];
    if (text) content.push(textPart(text));
    for (const a of attachments ?? []) {
      const typ = (a.type ?? "file").toLowerCase();
      const mediaType = ["image", "audio", "video", "pdf", "file"].includes(typ) ? typ : "file";
      content.push(
        mediaPart(mediaType as "image" | "audio" | "video" | "pdf" | "file", {
          type: a.type ?? "file",
          path: a.path,
          url: a.url,
          mime: a.mime,
          name: a.name,
        })
      );
    }
    return { content, contextTags: tags };
  }

  private extractFeishuErrorCode(err: unknown): number | null {
    if (Array.isArray(err)) {
      for (const item of err) {
        if (item && typeof item === "object" && typeof (item as { code?: number }).code === "number") {
          return (item as { code: number }).code;
        }
      }
    }
    if (err && typeof err === "object") {
      if (typeof (err as { code?: number }).code === "number") return (err as { code: number }).code;
      const respCode = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
      if (typeof respCode === "number") return respCode;
    }
    return null;
  }

  private async cachedFetch<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    fetcher: () => Promise<T>,
    fallback: () => T,
    errorHandler?: (err: unknown) => void,
  ): Promise<T> {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.value;
    try {
      const value = await fetcher();
      cache.set(key, { value, ts: Date.now() });
      return value;
    } catch (err) {
      errorHandler?.(err);
      const fb = fallback();
      cache.set(key, { value: fb, ts: Date.now() });
      return fb;
    }
  }

  private async getUserInfo(userId: string): Promise<UserInfo> {
    return this.cachedFetch(
      this.userCache,
      userId,
      async () => {
        const res = await this.client.contact.v3.user.get({
          path: { user_id: userId },
          params: { user_id_type: "open_id" },
        });
        const user = res.data?.user;
        const resolvedName = user?.name || user?.en_name || user?.nickname || "";
        if (!resolvedName) {
          this._log("warn", `getUserInfo(${userId}): 所有名称字段为空，应用可能缺少 contact:user.base:readonly 权限`);
        }
        return { name: resolvedName, openId: user?.open_id };
      },
      () => {
        let label = this.externalUserLabels.get(userId);
        if (!label) {
          this.externalUserCounter++;
          label = `外部用户${this.externalUserCounter}`;
          this.externalUserLabels.set(userId, label);
          this.saveExternalUserLabel(userId, label);
        }
        return { name: label } as UserInfo;
      },
      (err) => {
        const errCode = this.extractFeishuErrorCode(err);
        if (errCode === 41050) {
          this._log("info", `getUserInfo(${userId}): 外部用户，无权限获取通讯录信息 (41050)`);
        } else {
          const detail = (err as { response?: { data?: unknown }; message?: string })?.response?.data ?? (err as Error).message;
          this._log("warn", `failed to get user ${userId}`, { detail });
        }
      },
    );
  }

  private async getChatInfo(chatId: string): Promise<ChatInfo | null> {
    if (!chatId) return null;
    return this.cachedFetch(
      this.chatCache,
      chatId,
      async () => {
        const res = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
        return { name: res.data?.name || chatId };
      },
      () => ({ name: chatId }),
      (err) => {
        const errCode = this.extractFeishuErrorCode(err);
        if (errCode === 41050) {
          this._log("info", `getChatInfo(${chatId}): 无权限获取群信息 (41050)`);
        } else {
          const detail = (err as { response?: { data?: unknown }; message?: string })?.response?.data ?? (err as Error).message;
          this._log("warn", `failed to get chat ${chatId}`, { detail });
        }
      },
    );
  }

  private cleanExpiredCache(): void {
    const now = Date.now();

    for (const [key, entry] of this.userCache) {
      if (now - entry.ts > this.CACHE_TTL) {
        this.userCache.delete(key);
      }
    }

    for (const [key, entry] of this.chatCache) {
      if (now - entry.ts > this.CACHE_TTL) {
        this.chatCache.delete(key);
      }
    }

    this._log("debug", `cache cleaned: users=${this.userCache.size}, chats=${this.chatCache.size}`);
  }

  private async saveResourceToLocal(
    messageId: string,
    fileKey: string,
    resourceType: string,
    ailoType: "image" | "audio" | "video" | "file",
    fileName: string
  ): Promise<string | null> {
    const workDir = getWorkDir() ?? path.join(os.tmpdir(), "ailo-feishu-blobs");
    const now = new Date();
    const cacheDir = path.join(workDir, "blobs", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const sanitized = fileName.replace(/[/\\?*:|"<>]/g, "_").slice(0, 200);
    const outPath = path.join(cacheDir, `${Date.now()}_${sanitized}`);

    let buffer: Buffer | null = null;
    try {
      const res = await this.client.im.v1.messageResource.get({
        params: { type: resourceType },
        path: { message_id: messageId, file_key: fileKey },
      });
      if (res?.getReadableStream) buffer = await streamToBuffer(res.getReadableStream());
    } catch {
      // messageResource 可能失败，图片可尝试 image.get
    }
    if (!buffer && resourceType === "image" && ailoType === "image") {
      try {
        const res = await this.client.im.v1.image.get({ path: { image_key: fileKey } });
        if (res?.getReadableStream) buffer = await streamToBuffer(res.getReadableStream());
      } catch {
        // ignore
      }
    }
    if (!buffer) return null;
    await fs.promises.writeFile(outPath, buffer);
    return path.resolve(outPath);
  }

  async start(ctx: EndpointContext): Promise<void> {
    this.ctx = ctx;
    this.loadExternalUserLabels();
    this.fetchBotOpenId();

    const sink = (level: "debug" | "info" | "warn" | "error") => (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
      this._log(level, msg);
    };
    const stderrLogger = {
      error: sink("error"),
      warn: sink("warn"),
      info: sink("info"),
      debug: sink("debug"),
      trace: sink("debug"),
    };
    const wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Lark.Domain.Feishu,
      logger: stderrLogger,
      loggerLevel: Lark.LoggerLevel.info,
    });
    this.wsClient = wsClient;

    const eventDispatcher = new Lark.EventDispatcher({
      verificationToken: "",
      encryptKey: undefined,
    });

    if (this.cacheCleanupTimer) clearInterval(this.cacheCleanupTimer);
    this.cacheCleanupTimer = setInterval(() => this.cleanExpiredCache(), 60 * 60 * 1000);

    const wsClientAny = wsClient as unknown as { eventDispatcher: unknown; reConnect(isStart?: boolean): Promise<void> };
    wsClientAny.eventDispatcher = eventDispatcher;

    eventDispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        const event = data as FeishuMessageEvent;
        if (!event.message || !this.ctx) return;

        const msg = event.message;
        const rawContent = msg.content ?? "";
        const chatId = msg.chat_id ?? "";
        const messageId = msg.message_id ?? "";
        const chatType = msg.chat_type === "group" ? "group" : "p2p";

        const senderId =
          event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id ?? "";
        const messageType = msg.message_type ?? "";
        let createTimeMs = msg.create_time ? parseInt(msg.create_time, 10) : NaN;
        if (!isNaN(createTimeMs) && createTimeMs < 1e12) createTimeMs *= 1000;
        const timestamp = !isNaN(createTimeMs) ? createTimeMs : Date.now();

        if (!isNaN(createTimeMs) && Date.now() - createTimeMs > STALE_MESSAGE_THRESHOLD_MS) {
          this._log("info", `dropped stale message ${messageId}`, {
            create_time: createTimeMs,
            age_min: Math.round((Date.now() - createTimeMs) / 60000),
          });
          return;
        }

        this._log("debug", `received ${messageType} ${chatType} ${chatId} from ${senderId}`, {
          content_len: rawContent.length,
          preview: rawContent.length > 0 ? rawContent.slice(0, 200) : "",
        });

        const [userInfo, chatInfo] = await Promise.all([
          senderId ? this.getUserInfo(senderId) : Promise.resolve(null),
          chatType === "group" ? this.getChatInfo(chatId) : Promise.resolve(null),
        ]);
        this._log("debug", `sender=${senderId} name=${userInfo?.name ?? "(empty)"} chatType=${chatType} chatName=${chatInfo?.name ?? "(none)"}`);

        if (senderId && userInfo?.name) {
          this.mentionNameToId.set(userInfo.name, senderId);
        }

        let text = "";
        const attachments: FeishuAttachment[] = [];
        if (messageType === "text") {
          try {
            const content = JSON.parse(rawContent || "{}");
            text = content.text ?? "";
          } catch {
            text = rawContent;
          }
        } else if (messageType === "post") {
          text = extractTextFromPostContent(rawContent);
          const postImageKeys = [...new Set(extractImageKeysFromPostContent(rawContent))];
          for (const imageKey of postImageKeys) {
            const fileName = `image_${imageKey.slice(-12)}.png`;
            const absPath = await this.saveResourceToLocal(messageId, imageKey, "image", "image", fileName);
            if (absPath) attachments.push({ type: "image", path: absPath, name: path.basename(absPath) });
          }
        } else {
          const mediaConfig = MEDIA_MESSAGE_CONFIG[messageType];
          if (mediaConfig) {
            try {
              const content = JSON.parse(rawContent || "{}") as Record<string, string>;
              const fileKey = content[mediaConfig.contentKey];
              if (fileKey) {
                const fileName =
                  content["file_name"] ??
                  content["fileName"] ??
                  `${mediaConfig.ailoType}_${fileKey.slice(-12)}.${mediaConfig.ailoType === "image" ? "png" : mediaConfig.ailoType === "video" ? "mp4" : mediaConfig.ailoType === "audio" ? "mp3" : "bin"}`;
                const absPath = await this.saveResourceToLocal(
                  messageId,
                  fileKey,
                  mediaConfig.resourceType,
                  mediaConfig.ailoType,
                  fileName
                );
                if (absPath) attachments.push({ type: mediaConfig.ailoType, path: absPath, name: path.basename(absPath) });
                else text = `[无法获取${mediaConfig.ailoType}资源]`;
              } else {
                text = "[无法解析的媒体消息]";
              }
            } catch {
              text = "[无法解析的媒体消息]";
            }
          }
        }

        if (senderId && this.botOpenId && senderId === this.botOpenId) {
          this._log("debug", `skipped own message ${messageId}`);
          return;
        }

        if (!chatId) {
          this._log("warn", `dropped message ${messageId}: chat_id 为空，无法路由回复（飞书事件可能异常）`);
          return;
        }

        const mentions = msg.mentions;
        const { text: resolvedText, mentionsSelf } = this.resolveMentions(text, mentions);
        text = resolvedText;

        if (msg.parent_id) {
          text = `[回复消息 ${msg.parent_id}] ${text}`;
        }

        if (!text.trim() && attachments.length === 0) {
          text = messageType ? `[${messageType} 类型消息，暂不支持解析]` : "[未知类型消息]";
        }

        const isP2p = chatType === "p2p";
        this.acceptMessage(
          this.buildAcceptMessage({
            chatId,
            text,
            chatType: isP2p ? "私聊" : "群聊",
            senderId,
            senderName: userInfo?.name || "获取昵称失败",
            chatName: chatInfo?.name,
            mentionsSelf,
            attachments,
            timestamp,
          })
        );
      },
    });

    await wsClientAny.reConnect(true);
    this.ctx?.reportHealth("connected");
  }

  private inferFileType(fileName: string, mime?: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
    const ext = path.extname(fileName || "").toLowerCase().slice(1);
    const m = (mime ?? "").toLowerCase();
    if (["mp4", "mov", "avi", "mkv", "webm", "m4v"].includes(ext) || m.includes("video")) return "mp4";
    if (["opus", "mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext) || m.includes("audio")) return "opus";
    if (ext === "pdf" || m.includes("pdf")) return "pdf";
    if (["doc", "docx"].includes(ext) || m.includes("msword") || m.includes("document")) return "doc";
    if (["xls", "xlsx"].includes(ext) || m.includes("spreadsheet") || m.includes("excel")) return "xls";
    if (["ppt", "pptx"].includes(ext) || m.includes("presentation") || m.includes("powerpoint")) return "ppt";
    return "stream";
  }

  private async uploadFileToFeishu(opts: {
    filePath: string;
    fileName: string;
    fileType?: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
    mime?: string;
    duration?: number;
  }): Promise<string> {
    if (!fs.existsSync(opts.filePath)) {
      throw new Error(`文件不存在: ${opts.filePath}`);
    }
    const fileData = fs.readFileSync(opts.filePath);
    const fileType = opts.fileType ?? this.inferFileType(opts.fileName, opts.mime);
    let res: { file_key?: string };
    try {
      res = (await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: opts.fileName,
          file: fileData,
          ...(opts.duration != null && opts.duration > 0 ? { duration: opts.duration } : {}),
        },
      })) as { file_key?: string };
    } catch (e: unknown) {
      const err = e as { response?: { data?: unknown; status?: number }; message?: string };
      const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
      throw new Error(`飞书文件上传失败 (${err?.response?.status ?? "unknown"}): ${detail}`);
    }
    if (res?.file_key) return res.file_key;
    throw new Error(`飞书文件上传失败（无 file_key）: ${JSON.stringify(res)}`);
  }

  private async uploadImageToFeishu(opts: {
    filePath: string;
  }): Promise<string> {
    if (!fs.existsSync(opts.filePath)) {
      throw new Error(`图片文件不存在: ${opts.filePath}`);
    }
    const imageData = fs.readFileSync(opts.filePath);

    let res: { image_key?: string };
    try {
      res = (await this.client.im.image.create({
        data: {
          image_type: "message",
          image: imageData,
        },
      })) as { image_key?: string };
    } catch (e: unknown) {
      const err = e as { response?: { data?: unknown; status?: number }; message?: string };
      const respData = err?.response?.data;
      const detail = respData ? JSON.stringify(respData) : err?.message;
      throw new Error(`飞书图片上传失败 (${err?.response?.status ?? "unknown"}): ${detail}`);
    }

    const imageKey = res?.image_key;
    if (imageKey) {
      return imageKey;
    }
    throw new Error(`飞书图片上传失败（无 image_key）: ${JSON.stringify(res)}`);
  }

  async sendText(
    chatId: string,
    text: string,
    attachments?: Array<{
      type?: string;
      url?: string;
      mime?: string;
      file_path?: string;
      name?: string;
      duration?: number;
    }>
  ): Promise<void> {
    const trimmed = (text ?? "").trim();
    const allAttachments = attachments ?? [];
    const imageAttachments = allAttachments.filter((a) => (a.type ?? "").toLowerCase() === "image");
    const fileAttachments = allAttachments.filter((a) => {
      const t = (a.type ?? "").toLowerCase();
      if (t === "image") return false;
      if (["file", "audio", "video"].includes(t)) return true;
      return !!a.file_path;
    });

    if (!trimmed && imageAttachments.length === 0 && fileAttachments.length === 0) {
      return;
    }

    const receiveIdType = chatId.startsWith("ou_") ? "open_id" : "chat_id";

    const imageKeys: string[] = [];
    for (const att of imageAttachments) {
      if (att.file_path) {
        const key = await this.uploadImageToFeishu({ filePath: att.file_path });
        imageKeys.push(key);
      }
    }

    const contentRows: Array<Record<string, string>[]> = [];
    if (trimmed) {
      const { cleanText, atElements } = extractMentionElements(trimmed, this.mentionNameToId);
      const adapted = adaptMarkdownForFeishu(cleanText);
      const processed = convertMarkdownTablesToCodeBlock(adapted);
      const paragraphs = processed.split(/\n{2,}/).filter((p) => p.trim());
      if (paragraphs.length === 0) {
        contentRows.push([{ tag: "md", text: processed }]);
      } else {
        const firstRow: Record<string, string>[] = [];
        for (const at of atElements) {
          firstRow.push({ tag: "at", user_id: at.userId });
          firstRow.push({ tag: "text", text: " " });
        }
        firstRow.push({ tag: "md", text: paragraphs[0].trim() });
        contentRows.push(firstRow);
        for (let i = 1; i < paragraphs.length; i++) {
          contentRows.push([{ tag: "md", text: paragraphs[i].trim() }]);
        }
      }
    }
    for (const key of imageKeys) {
      contentRows.push([{ tag: "img", image_key: key }]);
    }
    if (contentRows.length > 0) {
      await this.client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify({
            zh_cn: {
              content: contentRows,
            },
          }),
        },
      });
    }

    for (const att of fileAttachments) {
      if (!att.file_path) continue;
      const fileName = att.name?.trim() || path.basename(att.file_path);
      const fileKey = await this.uploadFileToFeishu({
        filePath: att.file_path,
        fileName,
        mime: att.mime,
        duration: att.duration,
      });
      const msgType = (att.type ?? "file").toLowerCase();
      let content: string;
      if (msgType === "audio") {
        content = JSON.stringify({ file_key: fileKey, duration: att.duration ?? 0 });
      } else if (msgType === "video") {
        content = JSON.stringify({
          file_key: fileKey,
          file_name: fileName,
          duration: att.duration ?? 0,
        });
      } else {
        content = JSON.stringify({ file_key: fileKey, file_name: fileName });
      }
      await this.client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: chatId,
          msg_type: msgType === "video" ? "media" : msgType,
          content,
        },
      });
    }
  }

  async stop(): Promise<void> {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
    }
    if (this.wsClient) {
      try {
        const wsAny = this.wsClient as unknown as { ws?: { close?: () => void }; _closed?: boolean };
        if (wsAny.ws?.close) wsAny.ws.close();
      } catch { /* best-effort */ }
      this.wsClient = null;
    }
    this.ctx = null;
  }
}
