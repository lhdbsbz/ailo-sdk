#!/usr/bin/env node
import { runMcpChannel } from "@lmcl/ailo-channel-sdk";
import "dotenv/config";
import { WebchatHandler } from "./webchat-handler.js";
import { createWebchatMcpServer } from "./mcp-server.js";

const handler = new WebchatHandler({
  webPort: parseInt(process.env.WEBCHAT_PORT ?? "3001", 10),
});

function webchatBuildChannelInstructions(): string {
  return `这是一个网页聊天通道。

用户可以通过 Web 界面与你对话。消息会标注为"用户"发送。

回复时请使用 console 工具发送消息到网页聊天界面。`;
}

const mcpServer = createWebchatMcpServer(handler);

runMcpChannel({
  handler,
  displayName: "网页聊天",
  defaultRequiresResponse: true,
  buildChannelInstructions: webchatBuildChannelInstructions,
  mcpServer,
});
