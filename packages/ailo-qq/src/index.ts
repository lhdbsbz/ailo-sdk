#!/usr/bin/env node
import { runEndpoint } from "@lmcl/ailo-endpoint-sdk";
import "dotenv/config";
import { QQHandler } from "./qq-handler.js";

const QQ_APP_ID = process.env.QQ_APP_ID ?? "";
const QQ_APP_SECRET = process.env.QQ_APP_SECRET ?? "";

if (!QQ_APP_ID || !QQ_APP_SECRET) {
  console.error("Missing QQ_APP_ID or QQ_APP_SECRET");
  process.exit(1);
}

const handler = new QQHandler({
  appId: QQ_APP_ID,
  appSecret: QQ_APP_SECRET,
  apiBase: process.env.QQ_API_BASE,
});

runEndpoint({
  handler,
  displayName: "QQ",
  caps: ["message", "tool_execute"],
  blueprints: [
    process.env.BLUEPRINT_QQ_URL ??
      "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/qq-channel.blueprint.md",
  ],
  toolHandlers: {
    send: async (args: Record<string, unknown>) => {
      await handler.sendText(
        args.chat_id as string,
        (args.text as string) ?? "",
        (args.msg_id as string) ?? undefined,
      );
      return `已发送到 ${args.chat_id}`;
    },
  },
});
