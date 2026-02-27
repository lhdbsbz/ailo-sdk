#!/usr/bin/env node
import { runEndpoint } from "@lmcl/ailo-endpoint-sdk";
import "dotenv/config";
import { WebchatHandler } from "./webchat-handler.js";

const handler = new WebchatHandler({
  webPort: parseInt(process.env.WEBCHAT_PORT ?? "3001", 10),
});

runEndpoint({
  handler,
  displayName: "网页聊天",
  caps: ["message", "tool_execute"],
  blueprints: [
    process.env.BLUEPRINT_WEBCHAT_URL ??
      "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/webchat-channel.blueprint.md",
  ],
  instructions: "网页聊天通道。用户通过 Web 界面对话。",
  toolHandlers: {
    send: async (args: Record<string, unknown>) => {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const participantName =
        typeof args.participantName === "string" ? args.participantName.trim() : "";

      if (!text) {
        return "发送失败：text 不能为空";
      }
      if (!participantName) {
        return "发送失败：participantName 必填";
      }

      const ok = handler.recordAiloReply(text, participantName);
      return ok ? "已发送消息到网页聊天界面" : "发送失败：未找到对应用户名在线连接";
    },
  },
});
