import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync } from "fs";
import { dirname, extname, join, normalize } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, type WebSocket } from "ws";
import { StateStore } from "./state-store.js";
import { DeviceHub } from "./device-hub.js";

type StartServerDeps = {
  port: number;
  store: StateStore;
  hub: DeviceHub;
};

export interface WorldDemoServerRef {
  close(): Promise<void>;
}

function staticPath(name: string): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const srcFile = join(base, "..", "src", "static", name);
  if (existsSync(srcFile)) return srcFile;
  return join(base, "static", name);
}

function json(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(res: ServerResponse, filename: string, contentType: string): void {
  const file = staticPath(filename);
  const content = readFileSync(file);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

function contentTypeFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function serveStaticPath(res: ServerResponse, requestPath: string): void {
  const cleaned = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = staticPath(cleaned);
  const content = readFileSync(file);
  res.writeHead(200, { "Content-Type": contentTypeFor(file) });
  res.end(content);
}

export function startWorldDemoServer(deps: StartServerDeps): WorldDemoServerRef {
  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (payload: unknown): void => {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  deps.store.on("state", (snapshot) => broadcast({ type: "snapshot", payload: snapshot }));
  deps.store.on("log", (entry) => broadcast({ type: "log", payload: entry }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${deps.port}`);
    const path = url.pathname;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === "/" || path === "/index.html") return serveStatic(res, "index.html", "text/html; charset=utf-8");
      if (path.startsWith("/static/")) return serveStaticPath(res, path.slice("/static/".length));

      if (path === "/api/state" && req.method === "GET") return json(res, deps.store.snapshot());
      if (path === "/api/scenarios" && req.method === "GET") return json(res, deps.hub.listScenarios());

      if (path === "/api/connect" && req.method === "POST") {
        const body = await readBody(req);
        await deps.hub.connectAll(String(body.ailoWsUrl ?? ""), String(body.apiKey ?? ""));
        return json(res, { ok: true, connectedCount: deps.store.snapshot().connectedCount });
      }

      if (path === "/api/disconnect" && req.method === "POST") {
        await deps.hub.disconnectAll();
        return json(res, { ok: true });
      }

      if (path === "/api/scenario/run" && req.method === "POST") {
        const body = await readBody(req);
        await deps.hub.runScenario(String(body.id ?? ""));
        return json(res, { ok: true });
      }

      if (path === "/api/reset" && req.method === "POST") {
        await deps.hub.resetAll();
        return json(res, { ok: true });
      }

      if (path === "/api/device/action" && req.method === "POST") {
        const body = await readBody(req);
        const result = deps.hub.manualAction(
          String(body.endpointId ?? ""),
          String(body.tool ?? ""),
          (body.args as Record<string, unknown>) ?? {},
        );
        return json(res, result);
      }

      json(res, { error: "not found" }, 404);
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://localhost:${deps.port}`);
    if (url.pathname !== "/demo/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", payload: deps.store.snapshot() }));
    ws.on("close", () => clients.delete(ws));
  });

  server.listen(deps.port, "127.0.0.1");

  return {
    close: async () => {
      await deps.hub.disconnectAll();
      for (const client of clients) client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
