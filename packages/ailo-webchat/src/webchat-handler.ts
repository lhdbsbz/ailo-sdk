import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  EndpointHandler,
  EndpointContext,
} from "@lmcl/ailo-endpoint-sdk";
import type { AcceptMessage, ContextTag } from "@lmcl/ailo-endpoint-sdk";
import { textPart } from "@lmcl/ailo-endpoint-sdk";

export interface WebchatConfig {
  /** Web UI 端口 */
  webPort?: number;
}

export class WebchatHandler implements EndpointHandler {
  private ctx: EndpointContext | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private clientsByParticipant: Map<string, Set<WebSocket>> = new Map();
  private participantByClient: Map<WebSocket, string> = new Map();
  private config: WebchatConfig;

  constructor(config: WebchatConfig = {}) {
    this.config = config;
  }

  async start(ctx: EndpointContext): Promise<void> {
    this.ctx = ctx;
    const port = this.config.webPort ?? 3001;
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "console.html");

    // 创建 HTTP 服务器
    this.httpServer = createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        try {
          const html = readFileSync(htmlPath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          res.writeHead(500);
          res.end("Failed to load HTML");
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // 创建 WebSocket 服务器，挂载到 HTTP 服务器
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.ctx?.log("info", `网页聊天客户端已连接, total: ${this.clients.size}`);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "chat") {
            this.handleChatMessage(msg.text, msg.participantName, ws);
          }
        } catch (err) {
          this.ctx?.log("warn", `Failed to parse WebSocket message: ${err}`);
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.unbindClient(ws);
        this.ctx?.log("info", `网页聊天客户端已断开, remaining: ${this.clients.size}`);
      });

      ws.on("error", (err) => {
        this.ctx?.log("error", `WebSocket error: ${err}`);
      });
    });

    this.httpServer.listen(port, () => {
      this.ctx?.log("info", `网页聊天服务已启动 http://localhost:${port}`);
    });

    this.ctx.reportHealth("connected");
  }

  private normalizeParticipantName(participantName?: string): string {
    return typeof participantName === "string" ? participantName.trim() : "";
  }

  private bindClient(participantName: string, ws: WebSocket): void {
    const previous = this.participantByClient.get(ws);
    if (previous && previous !== participantName) {
      const previousSet = this.clientsByParticipant.get(previous);
      previousSet?.delete(ws);
      if (previousSet && previousSet.size === 0) {
        this.clientsByParticipant.delete(previous);
      }
    }

    let group = this.clientsByParticipant.get(participantName);
    if (!group) {
      group = new Set<WebSocket>();
      this.clientsByParticipant.set(participantName, group);
    }
    group.add(ws);
    this.participantByClient.set(ws, participantName);
  }

  private unbindClient(ws: WebSocket): void {
    const participantName = this.participantByClient.get(ws);
    if (!participantName) return;

    this.participantByClient.delete(ws);
    const group = this.clientsByParticipant.get(participantName);
    group?.delete(ws);
    if (group && group.size === 0) {
      this.clientsByParticipant.delete(participantName);
    }
  }

  private handleChatMessage(text: string, participantName: string | undefined, ws: WebSocket): void {
    if (!this.ctx || !text.trim()) return;

    const routeName = this.normalizeParticipantName(participantName);
    if (!routeName) {
      this.ctx.log("warn", "Webchat 上行消息缺少 participantName，已拒绝");
      return;
    }
    this.bindClient(routeName, ws);

    const tags: ContextTag[] = [
      { kind: "conv_type", value: "私聊", groupWith: false },
      { kind: "chat_id", value: routeName, groupWith: true, passToTool: true },
      { kind: "participant", value: routeName, groupWith: false },
    ];

    const msg: AcceptMessage = {
      content: [textPart(text)],
      contextTags: tags,
    };

    this.ctx.accept(msg).catch((err) => {
      this.ctx?.log("error", `Failed to send message to Ailo: ${err}`);
    });
  }

  /** 保存 Ailo 回复并发送给指定用户名（历史由前端 localStorage 管理） */
  recordAiloReply(text: string, participantName: string): boolean {
    return this.sendToParticipant(participantName, text);
  }

  /** 供 MCP 工具调用的定向回复方法 */
  sendToParticipant(participantName: string, text: string): boolean {
    const routeName = this.normalizeParticipantName(participantName);
    if (!routeName) {
      this.ctx?.log("warn", "Webchat 下行消息缺少 participantName，已拒绝");
      return false;
    }

    const group = this.clientsByParticipant.get(routeName);
    if (!group || group.size === 0) {
      this.ctx?.log("warn", `未找到用户名为 ${routeName} 的在线客户端，消息未发送`);
      return false;
    }

    const msg = JSON.stringify({ type: "reply", text });
    let sent = 0;
    for (const client of group) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
        sent += 1;
      }
    }
    if (sent === 0) {
      this.ctx?.log("warn", `用户名 ${routeName} 的连接均不可写，消息未发送`);
      return false;
    }
    return true;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.clientsByParticipant.clear();
    this.participantByClient.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    this.ctx = null;
  }
}
