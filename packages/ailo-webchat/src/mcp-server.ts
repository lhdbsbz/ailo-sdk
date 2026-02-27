/**
 * 网页聊天通道 MCP：console 工具，用于发送消息到网页聊天界面。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebchatHandler } from "./webchat-handler.js";

type ConsoleToolArgs = {
  action: "send";
  text: string;
  participantName: string;
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
        participantName: z.string().min(1).describe("目标使用者名称（路由主键）"),
      },
    },
    async (args: ConsoleToolArgs) => {
      if (args.action === "send") {
        const text = args.text.trim();
        const participantName = args.participantName.trim();
        if (!text) {
          return {
            content: [{ type: "text" as const, text: "发送失败：text 不能为空" }],
            isError: true,
          };
        }
        if (!participantName) {
          return {
            content: [{ type: "text" as const, text: "发送失败：participantName 必填" }],
            isError: true,
          };
        }

        const ok = handler.recordAiloReply(text, participantName);
        return {
          content: [
            {
              type: "text" as const,
              text: ok ? "已发送消息到网页聊天界面" : "发送失败：未找到对应用户名在线连接",
            },
          ],
          isError: !ok,
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
