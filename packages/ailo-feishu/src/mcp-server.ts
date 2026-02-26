/**
 * 飞书通道 MCP：stdio 传输，单工具 action 驱动。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FeishuHandler } from "./feishu-handler.js";

const attachmentSchema = z.object({
  type: z.string().optional().describe("image|file|audio|video"),
  path: z.string().optional(),
  base64: z.string().optional(),
  mime: z.string().optional(),
  name: z.string().optional().describe("文件名，用于 file/audio/video"),
  duration: z.number().optional().describe("音视频时长(毫秒)，用于 audio/video"),
});

const feishuSchema = {
  action: z.enum(["send", "read_doc", "set_nickname"]).describe("send=发消息; read_doc=读文档; set_nickname=设置备注"),
  chat_id: z.string().optional(),
  text: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  url: z.string().optional(),
  sender_id: z.string().optional(),
  nickname: z.string().optional(),
};

export function createFeishuMcpServer(handler: FeishuHandler): McpServer {
  const server = new McpServer({ name: "feishu", version: "0.1.0" });

  server.registerTool(
    "feishu",
    {
      description:
        "飞书操作。action=send 发消息(需 chat_id,text；attachments 可选)：type=image 图片；type=file 文件；type=audio 音频；type=video 视频。附件用 path 或 base64，可选 name/duration。read_doc 读文档(需 url)；set_nickname 设置备注(需 sender_id,nickname)。chat_id: ou_xxx 私聊/oc_xxx 群聊。",
      inputSchema: feishuSchema,
    },
    async (args) => {
      const { action } = args;
      if (action === "send") {
        const atts = (args.attachments ?? []).map((a) => ({
          type: a.type,
          file_path: a.path,
          base64: a.base64,
          mime: a.mime,
          name: a.name,
          duration: a.duration,
        }));
        await handler.sendText(args.chat_id!, args.text ?? "", atts);
        return { content: [{ type: "text" as const, text: `已发送到 ${args.chat_id}` }], isError: false };
      }
      if (action === "read_doc") {
        const content = await handler.fetchDocRawContent(args.url!);
        return content === null
          ? { content: [{ type: "text" as const, text: "无法获取文档" }], isError: true }
          : { content: [{ type: "text" as const, text: content }], isError: false };
      }
      await handler.onCommand("set_nickname", { sender_id: args.sender_id!, nickname: args.nickname! });
      return {
        content: [{ type: "text" as const, text: `已将 ${args.sender_id} 的备注设为 ${args.nickname}` }],
        isError: false,
      };
    }
  );
  return server;
}
