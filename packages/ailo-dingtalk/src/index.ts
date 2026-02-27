#!/usr/bin/env node
import { runEndpoint } from "@lmcl/ailo-endpoint-sdk";
import "dotenv/config";
import { DingTalkHandler } from "./dingtalk-handler.js";

const DINGTALK_CLIENT_ID = process.env.DINGTALK_CLIENT_ID ?? "";
const DINGTALK_CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET ?? "";

if (!DINGTALK_CLIENT_ID || !DINGTALK_CLIENT_SECRET) {
  console.error("Missing DINGTALK_CLIENT_ID or DINGTALK_CLIENT_SECRET");
  process.exit(1);
}

const handler = new DingTalkHandler({ clientId: DINGTALK_CLIENT_ID, clientSecret: DINGTALK_CLIENT_SECRET });

runEndpoint({
  handler,
  displayName: "钉钉",
  caps: ["message", "tool_execute"],
  blueprints: [
    process.env.BLUEPRINT_DINGTALK_URL ??
      "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/dingtalk-channel.blueprint.md",
  ],
  toolHandlers: {
    send: async (args: Record<string, unknown>) => {
      await handler.sendText(args.chat_id as string, (args.text as string) ?? "");
      return `已发送到 ${args.chat_id}`;
    },
  },
});
