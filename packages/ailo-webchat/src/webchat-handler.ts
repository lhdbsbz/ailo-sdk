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
            this.handleChatMessage(msg.text, msg.participantName);
          }
        } catch (err) {
          this.ctx?.log("warn", `Failed to parse WebSocket message: ${err}`);
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
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

  private handleChatMessage(text: string, participantName?: string): void {
    if (!this.ctx || !text.trim()) return;

    const name = participantName?.trim() || "用户";

    const tags: ContextTag[] = [
      { kind: "conv_type", value: "私聊", streamKey: false },
      { kind: "chat_id", value: "console", streamKey: true, routing: true },
      { kind: "participant", value: name, streamKey: false },
    ];

    const msg: AcceptMessage = {
      content: [textPart(text)],
      contextTags: tags,
    };

    this.ctx.accept(msg).catch((err) => {
      this.ctx?.log("error", `Failed to send message to Ailo: ${err}`);
    });
  }

  /** 保存 Ailo 回复并发送给客户端（历史由前端 localStorage 管理） */
  recordAiloReply(text: string): void {
    this.sendToClients(text);
  }

  /** 供 MCP 工具调用的回复方法 */
  sendToClients(text: string): void {
    const msg = JSON.stringify({ type: "reply", text });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

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
