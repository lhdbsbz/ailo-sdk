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
      handler.recordAiloReply(args.text as string);
      return "已发送消息到网页聊天界面";
    },
  },
});
