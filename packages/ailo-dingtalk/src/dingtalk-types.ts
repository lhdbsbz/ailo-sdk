export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
}

export interface DingTalkBotMessage {
  conversationId: string;
  conversationType: string; // "1" = private, "2" = group
  chatbotCorpId?: string;
  chatbotUserId?: string;
  msgId: string;
  msgtype: string;
  text?: { content: string };
  senderNick: string;
  senderStaffId: string;
  senderCorpId?: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime: number;
  createAt: number;
  conversationTitle?: string;
  atUsers?: Array<{ dingtalkId: string; staffId?: string }>;
  isAdmin?: boolean;
  isInAtList?: boolean;
}

export const STALE_MESSAGE_THRESHOLD_MS = 5 * 60 * 1000;
