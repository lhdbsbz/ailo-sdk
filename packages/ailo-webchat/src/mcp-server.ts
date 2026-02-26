/**
 * 网页聊天通道 MCP：console 工具，用于发送消息到网页聊天界面。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebchatHandler } from "./webchat-handler.js";

type ConsoleToolArgs = {
  action: "send";
  text: string;
};

export function createWebchatMcpServer(handler: WebchatHandler): McpServer {
  const server = new McpServer({ name: "ailo-webchat", version: "0.1.0" });

  server.registerTool(
    "console",
    {
      description: "发送消息到网页聊天界面。action=send 时，text 为要发送的文本内容。",
      inputSchema: {
        action: z.enum(["send"]),
        text: z.string().describe("要发送的文本内容"),
      },
    },
    async (args: ConsoleToolArgs) => {
      if (args.action === "send") {
        handler.recordAiloReply(args.text);
        return {
          content: [{ type: "text" as const, text: "已发送消息到网页聊天界面" }],
          isError: false,
        };
      }
      return {
        content: [{ type: "text" as const, text: `未知操作: ${args.action}` }],
        isError: false,
      };
    }
  );

  return server;
}
