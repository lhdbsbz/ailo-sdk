export interface QQConfig {
  appId: string;
  appSecret: string;
  apiBase?: string;
}

export const OP_DISPATCH = 0;
export const OP_HEARTBEAT = 1;
export const OP_IDENTIFY = 2;
export const OP_RESUME = 6;
export const OP_RECONNECT = 7;
export const OP_INVALID_SESSION = 9;
export const OP_HELLO = 10;
export const OP_HEARTBEAT_ACK = 11;

export const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
export const INTENT_DIRECT_MESSAGE = 1 << 12;
export const INTENT_GROUP_AND_C2C = 1 << 25;

export const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
export const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

export const RECONNECT_DELAYS = [1, 2, 5, 10, 30, 60];
export const MAX_RECONNECT_ATTEMPTS = 50;

export interface QQGatewayPayload {
  op: number;
  d?: any;
  s?: number;
  t?: string;
}

export interface QQMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string; bot?: boolean };
  channel_id?: string;
  guild_id?: string;
  group_openid?: string;
  group_id?: string;
}

export interface QQC2CMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; user_openid?: string; username?: string };
}
