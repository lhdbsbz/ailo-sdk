/**
 * 媒体数据（与 Ailo llm.MediaData 对齐）
 */
export type MediaData = {
  type: string;
  url?: string;
  path?: string;
  base64?: string;
  mime?: string;
  name?: string;
};

/**
 * 内容块（与 Ailo llm.ContentPart 对齐）
 */
export type ContentPart = {
  type: "text" | "image" | "audio" | "video" | "pdf" | "file";
  text?: string;
  media?: MediaData;
};

/** 创建 text part */
export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

/** 创建 media part */
export function mediaPart(type: "image" | "audio" | "video" | "pdf" | "file", media: MediaData): ContentPart {
  return { type, media };
}

/**
 * 时空场标签。
 */
export type ContextTag = {
  kind: string;
  value: string;
  streamKey: boolean;
  routing?: boolean;
};

/**
 * 通道入站消息（平台 → Ailo）
 */
export type ChannelMessage = {
  content: ContentPart[];
  contextTags: ContextTag[];
  requiresResponse?: boolean;
};

/**
 * 通道级 KV 存储
 */
export interface ChannelStorage {
  getData(key: string): Promise<string | null>;
  setData(key: string, value: string): Promise<void>;
  deleteData(key: string): Promise<void>;
}

/**
 * 通道运行时上下文
 */
export interface ChannelContext {
  accept(msg: ChannelMessage): Promise<void>;
  storage: ChannelStorage;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  reportHealth(status: "connected" | "reconnecting" | "error", detail?: string): void;
  onSignal(signal: string, callback: (data: unknown) => void): void;
  sendSignal(signal: string, data?: unknown): void;
}

/**
 * 通道 Handler 接口
 */
export interface ChannelHandler {
  start(ctx: ChannelContext): void | Promise<void>;
  stop(): void | Promise<void>;
}
