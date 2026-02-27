#!/usr/bin/env node
import { runEndpoint } from "@lmcl/ailo-endpoint-sdk";
import "dotenv/config";
import { DiscordHandler } from "./discord-handler.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";

if (!DISCORD_BOT_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

const handler = new DiscordHandler({
  botToken: DISCORD_BOT_TOKEN,
  httpProxy: process.env.DISCORD_HTTP_PROXY,
});

runEndpoint({
  handler,
  displayName: "Discord",
  caps: ["message", "tool_execute"],
  blueprints: [
    process.env.BLUEPRINT_DISCORD_URL ??
      "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/discord-channel.blueprint.md",
  ],
  toolHandlers: {
    send: async (args: Record<string, unknown>) => {
      await handler.sendText(args.chat_id as string, (args.text as string) ?? "");
      return `已发送到 ${args.chat_id}`;
    },
  },
});
