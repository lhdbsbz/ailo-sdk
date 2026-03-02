/**
 * 邮件通道 MCP：单一 email 工具，通过 action 参数分发所有能力。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EmailHandler } from "./email-handler.js";

const actionSchema = z.enum([
  "send",
  "reply",
  "forward",
  "list",
  "read",
  "search",
  "mark_read",
  "move",
  "delete",
  "get_attachment",
]);

type EmailToolArgs = {
  action: z.infer<typeof actionSchema>;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  html?: string;
  uid?: number;
  uids?: number[];
  folder?: string;
  from_folder?: string;
  limit?: number;
  offset?: number;
  unread_only?: boolean;
  read?: boolean;
  query?: string;
  from?: string;
  to_search?: string;
  since?: string;
  until?: string;
  filename?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
};

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createEmailMcpServer(handler: EmailHandler): McpServer {
  const server = new McpServer({ name: "email", version: "0.1.0" });

  server.registerTool(
    "email",
    {
      description: `邮件操作统一入口。action 取值：
- send: 发送新邮件（to, body, subject?, cc?, bcc?, html?, attachments?）
- reply: 回复邮件（uid, body, folder?, html?, attachments?）
- forward: 转发邮件（uid, to, folder?, cc?, bcc?, body?）
- list: 邮件列表（folder?, limit?, offset?, unread_only?）
- read: 读取单封详情（uid, folder?）
- search: 搜索（query?, from?, to?, subject?, since?, until?, folder?, limit?）
- mark_read: 标记已读/未读（uids, read, folder?）
- move: 移动邮件（uids, folder, from_folder?）
- delete: 删除邮件（uids, folder?）
- get_attachment: 下载附件 base64（uid, filename, folder?）`,
      inputSchema: {
        action: actionSchema,
        to: z.string().optional(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        html: z.string().optional(),
        uid: z.number().optional(),
        uids: z.array(z.number()).max(500).optional(),
        folder: z.string().optional(),
        from_folder: z.string().optional(),
        limit: z.number().min(1).max(200).optional(),
        offset: z.number().min(0).optional(),
        unread_only: z.boolean().optional(),
        read: z.boolean().optional(),
        query: z.string().optional(),
        from: z.string().optional(),
        to_search: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        filename: z.string().optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              content: z.string(),
              contentType: z.string().optional(),
            })
          )
          .optional(),
      },
    },
    async (args: EmailToolArgs) => {
      try {
        const a = args.action;
        switch (a) {
          case "send": {
            if (!args.to || args.body === undefined)
              return err("send 需要 to 和 body");
            await handler.send({
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
              html: args.html,
              attachments: args.attachments,
            });
            return ok(`邮件已发送至 ${args.to}`);
          }
          case "reply": {
            if (args.uid === undefined || args.body === undefined)
              return err("reply 需要 uid 和 body");
            await handler.reply({
              uid: args.uid,
              folder: args.folder,
              body: args.body,
              html: args.html,
              attachments: args.attachments,
            });
            return ok(`已回复 uid=${args.uid}`);
          }
          case "forward": {
            if (args.uid === undefined || !args.to)
              return err("forward 需要 uid 和 to");
            await handler.forward({
              uid: args.uid,
              folder: args.folder,
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              body: args.body,
            });
            return ok(`已转发至 ${args.to}`);
          }
          case "list": {
            const items = await handler.list({
              folder: args.folder,
              limit: args.limit,
              offset: args.offset,
              unreadOnly: args.unread_only,
            });
            const lines = items.map(
              (i) =>
                `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`
            );
            return ok(lines.length ? lines.join("\n") : "（无邮件）");
          }
          case "read": {
            if (args.uid === undefined) return err("read 需要 uid");
            const d = await handler.read({ uid: args.uid, folder: args.folder });
            if (!d) return err(`uid=${args.uid} 不存在`);
            const att = d.attachments.length
              ? `\n附件: ${d.attachments.map((a) => `${a.filename} (${a.size}B)`).join(", ")}`
              : "";
            return ok(
              `from: ${d.from}\nto: ${d.to}\nsubject: ${d.subject}\ndate: ${d.date}\n\n${d.text ?? d.html ?? ""}${att}`
            );
          }
          case "search": {
            const items = await handler.search({
              query: args.query,
              from: args.from,
              to: args.to_search,
              subject: args.subject,
              since: args.since,
              until: args.until,
              folder: args.folder,
              limit: args.limit,
            });
            const lines = items.map(
              (i) =>
                `uid=${i.uid} ${i.isRead ? "✓" : "○"} ${i.from} | ${i.subject} | ${i.date}`
            );
            return ok(lines.length ? lines.join("\n") : "（无匹配）");
          }
          case "mark_read": {
            if (!args.uids?.length || args.read === undefined)
              return err("mark_read 需要 uids 和 read");
            await handler.markRead({
              uids: args.uids,
              read: args.read,
              folder: args.folder,
            });
            return ok(`已标记 ${args.uids.length} 封为${args.read ? "已读" : "未读"}`);
          }
          case "move": {
            if (!args.uids?.length || !args.folder)
              return err("move 需要 uids 和 folder");
            await handler.move({
              uids: args.uids,
              folder: args.folder,
              fromFolder: args.from_folder,
            });
            return ok(`已移动 ${args.uids.length} 封到 ${args.folder}`);
          }
          case "delete": {
            if (!args.uids?.length) return err("delete 需要 uids");
            await handler.delete({ uids: args.uids, folder: args.folder });
            return ok(`已删除 ${args.uids.length} 封`);
          }
          case "get_attachment": {
            if (args.uid === undefined || !args.filename)
              return err("get_attachment 需要 uid 和 filename");
            const localPath = await handler.downloadAttachment({
              uid: args.uid,
              folder: args.folder,
              filename: args.filename,
            });
            if (!localPath) return err(`附件 ${args.filename} 不存在`);
            return ok(`附件已下载到 ${localPath}`);
          }
          default:
            return err(`未知 action: ${a}`);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`操作失败: ${msg}`);
      }
    }
  );

  return server;
}
