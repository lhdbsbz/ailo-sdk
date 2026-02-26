#!/usr/bin/env node
import { runMcpChannel } from "@lmcl/ailo-channel-sdk";
import "dotenv/config";
import { FeishuHandler } from "./feishu-handler.js";
import { createFeishuMcpServer } from "./mcp-server.js";

const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? "";

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  process.exit(1);
}

const handler = new FeishuHandler({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

function feishuBuildChannelInstructions(): string {
  return `ID 格式：ou_xxx 是飞书用户 ID，oc_xxx 是群组 ID。

@提及：@提及格式为 @显示名(ou_xxx)。使用此格式可触发飞书强提醒。

表情：飞书仅支持 Unicode emoji（😊👍❤️），不支持 :xxx: 冒号格式。

外部用户：昵称为"外部用户N"的是非本组织成员，飞书无法获取其真实姓名。同一编号始终对应同一人。昵称可通过 feishu action=set_nickname 更新。

转发限制：私聊消息只能发给曾与你发起过私聊的用户。`;
}

const mcpServer = createFeishuMcpServer(handler);

runMcpChannel({
  handler,
  displayName: "飞书",
  defaultRequiresResponse: true,
  buildChannelInstructions: feishuBuildChannelInstructions,
  mcpServer,
});
