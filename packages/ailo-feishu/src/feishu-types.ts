/** 类型、常量 */
export type FeishuConfig = {
  appId: string;
  appSecret: string;
};

export type FeishuAttachment = {
  type: string;
  url?: string;
  path?: string;
  ref?: string;
  channel?: string;
  base64?: string;
  mime?: string;
  name?: string;
};

export type OnChatId = (chatId: string) => void;

export type FeishuMention = {
  key: string;
  id: { open_id?: string; user_id?: string };
  name: string;
  tenant_key?: string;
};

export type FeishuMessageEvent = {
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: "p2p" | "group";
    message_type?: string;
    content?: string;
    create_time?: string;
    mentions?: FeishuMention[];
  };
  sender?: {
    sender_id?: { open_id?: string; user_id?: string };
  };
};

export type FeishuChatIdEvent = { chat_id?: string; event?: { chat_id?: string } };

export type FeishuRecalledEvent = {
  message_id?: string;
  chat_id?: string;
  recall_time?: string;
  recall_type?: string;
};

export type FeishuReactionEvent = {
  message_id?: string;
  reaction_type?: { emoji_type?: string };
  user_id?: { open_id?: string; user_id?: string };
  action_time?: string;
};

export interface CacheEntry<T> {
  value: T;
  ts: number;
}

export interface UserInfo {
  name: string;
  openId?: string;
}

export interface ChatInfo {
  name: string;
}

export const STALE_MESSAGE_THRESHOLD_MS = 5 * 60 * 1000;
export const NEGATIVE_CACHE_TTL = 5 * 60 * 1000;

export const MEDIA_MESSAGE_CONFIG: Record<
  string,
  { resourceType: string; ailoType: "image" | "audio" | "video" | "file"; contentKey: string }
> = {
  image: { resourceType: "image", ailoType: "image", contentKey: "image_key" },
  file: { resourceType: "file", ailoType: "file", contentKey: "file_key" },
  audio: { resourceType: "audio", ailoType: "audio", contentKey: "file_key" },
  media: { resourceType: "video", ailoType: "video", contentKey: "file_key" },
  video: { resourceType: "video", ailoType: "video", contentKey: "file_key" },
};
