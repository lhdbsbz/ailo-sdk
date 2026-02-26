/**
 * 媒体数据（与 ailo-channel-sdk 对齐）
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
 * 内容块（与 ailo-channel-sdk 对齐）
 */
export type ContentPart = {
  type: "text" | "image" | "audio" | "video" | "pdf" | "file";
  text?: string;
  media?: MediaData;
};

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function mediaPart(
  type: "image" | "audio" | "video" | "pdf" | "file",
  media: MediaData
): ContentPart {
  return { type, media };
}

/**
 * 时空场标签（与 ailo-channel-sdk 对齐）
 */
export type ContextTag = {
  kind: string;
  value: string;
  streamKey: boolean;
  routing?: boolean;
};

/**
 * 感知上报（Channel → Ailo 意识流）
 */
export type Percept = {
  content: ContentPart[];
  contextTags: ContextTag[];
  requiresResponse?: boolean;
};

/**
 * Limb 级 KV 存储
 */
export interface LimbStorage {
  getData(key: string): Promise<string | null>;
  setData(key: string, value: string): Promise<void>;
  deleteData(key: string): Promise<void>;
}

/**
 * Limb 运行时上下文（由 SDK 注入，Handler 使用）
 */
export interface LimbContext {
  /** 上报感知，推入 Ailo 意识流 */
  percept(p: Percept): Promise<void>;
  /** 持久化存储 */
  storage: LimbStorage;
  /** 日志（通过 WS 发给 Ailo 代打，避免 stdout 冲突） */
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  /** 上报自身健康状态 */
  reportHealth(status: "connected" | "reconnecting" | "error", detail?: string): void;
}

/**
 * Channel Handler 接口 —— 设备端实现此接口
 */
export interface LimbHandler {
  /** SDK 就绪后调用，ctx 可用于上报感知 */
  start(ctx: LimbContext): void | Promise<void>;
  /** 进程退出前调用 */
  stop(): void | Promise<void>;
}
