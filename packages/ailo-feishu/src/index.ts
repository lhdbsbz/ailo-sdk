#!/usr/bin/env node
import { runEndpoint } from "@lmcl/ailo-endpoint-sdk";
import "dotenv/config";
import { FeishuHandler } from "./feishu-handler.js";

const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? "";

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  process.exit(1);
}

const handler = new FeishuHandler({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

runEndpoint({
  handler,
  displayName: "飞书",
  caps: ["message", "tool_execute"],
  blueprints: [
    process.env.BLUEPRINT_FEISHU_URL ??
      "https://raw.githubusercontent.com/lhdbsbz/ailo-sdk/master/blueprints/feishu-channel.blueprint.md",
  ],
  instructions: "外部用户：昵称为\"外部用户N\"的是非本组织成员。同一编号始终对应同一人。",
  toolHandlers: {
    send: async (args: Record<string, unknown>) => {
      const atts = ((args.attachments as any[]) ?? []).map((a: any) => ({
        type: a.type,
        file_path: a.path,
        base64: a.base64,
        mime: a.mime,
        name: a.name,
        duration: a.duration,
      }));
      await handler.sendText(args.chat_id as string, (args.text as string) ?? "", atts);
      return `已发送到 ${args.chat_id}`;
    },
    set_nickname: async (args: Record<string, unknown>) => {
      await handler.onCommand("set_nickname", {
        sender_id: args.sender_id as string,
        nickname: args.nickname as string,
      });
      return `已将 ${args.sender_id} 的备注设为 ${args.nickname}`;
    },
  },
});
