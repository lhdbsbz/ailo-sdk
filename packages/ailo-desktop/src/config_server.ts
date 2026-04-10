import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { WebSocketServer, type WebSocket } from "ws";
import type { EndpointContext } from "@greatlhd/ailo-endpoint-sdk";
import type { AcceptMessage, ContextTag } from "@greatlhd/ailo-endpoint-sdk";
import { textPart, readConfig, writeConfig, getNestedValue, setNestedValue, EndpointError, ConsoleLogger, createComponentLogger } from "@greatlhd/ailo-endpoint-sdk";
import type { LocalMCPManager } from "./mcp_manager.js";
import { errMsg } from "./utils.js";

// 使用 SDK 的日志系统
const configLogger = createComponentLogger("config", new ConsoleLogger("[desktop]"));

/** 网页聊天消息内容项 */
export type WebchatContentItem =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string; name?: string }
  | { kind: 'file'; url: string; name?: string };

function resolveStaticFile(filename: string): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const inStatic = join(base, "static", filename);
  if (existsSync(inStatic)) return inStatic;
  return join(base, "..", "src", "static", filename);
}

/** 单项运行环境检测结果 */
export interface EnvRuntimeItem {
  id: string;
  name: string;
  description: string;
  ok: boolean;
  detail?: string;
  hint?: string;
  canAutoInstall?: boolean;
}

/** 运行环境检测结果（供 Skills / 代码执行等使用） */
export interface EnvCheckResult {
  runtimes: EnvRuntimeItem[];
}

interface ConfigServerDeps {
  mcpManager: LocalMCPManager;
  getConnectionStatus: () => { connected: boolean; endpointId: string };
  port: number;
  /** config.json path for Ailo connection config */
  configPath?: string;
  /** 当存在时启用网页聊天：同一端口提供 /chat 与 /chat/ws，并调用 onWebchatReady */
  webchatCtx?: EndpointContext;
  /** 动态获取网页聊天上下文（连接建立后可挂载，无需重启） */
  getWebchatCtx?: () => EndpointContext | null;
  /** 获取端点上下文（用于获取已上报的工具和技能） */
  getEndpointCtx?: () => EndpointContext | null;
  /** 获取已上报的内置工具列表 */
  getEndpointTools?: () => { name: string; description: string }[];
  /** 获取已上报的技能列表 */
  getEndpointSkills?: () => { name: string; description: string }[];
  /** 网页聊天就绪后回调，供 index 的 send 工具使用 */
  onWebchatReady?: (api: { recordAiloReply: (text: string, participantName: string, content?: WebchatContentItem[]) => boolean }) => void;
  /** 有浏览器打开 /chat 并连上 /chat/ws 或全部关闭时调用，用于刷新是否上报 webchat_send */
  onWebchatClientsChanged?: () => void | Promise<void>;
  /** 请求热重连以刷新服务端 Skills 列表（启用/禁用后调用，无需重启） */
  onRequestReconnect?: () => Promise<void>;
  /** 保存 Ailo 连接配置后调用，用于断线后使用新配置重连 */
  onConnectionConfigSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string }) => Promise<void>;
}

function getChatHtmlPath(): string {
  return resolveStaticFile("chat.html");
}

function serveChatPage(res: ServerResponse, htmlPath: string): void {
  try {
    const html = readFileSync(htmlPath, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e: unknown) {
    res.writeHead(500);
    res.end("Failed to load chat page: " + errMsg(e));
  }
}

export interface ConfigServerRef {
  /** 连接建立后调用，使网页聊天与 onWebchatReady 生效 */
  notifyContextAttached(): void;
  /** 是否有浏览器标签页已打开聊天页并连上 WebSocket（用于决定是否向 Ailo 上报 webchat_send） */
  hasWebchatPageConnected(): boolean;
}

export function startConfigServer(deps: ConfigServerDeps): ConfigServerRef {
  const chatHtmlPath = getChatHtmlPath();
  const clientsByParticipant = new Map<string, Set<WebSocket>>();
  const participantByClient = new Map<WebSocket, string>();
  /** 当前连到 /chat/ws 的套接字（页面打开即有一条，与是否 register 无关） */
  const allChatSockets = new Set<WebSocket>();
  const getWebchatCtx = (): EndpointContext | null => deps.getWebchatCtx?.() ?? deps.webchatCtx ?? null;
  const wss = new WebSocketServer({ noServer: true });

  function notifyWebchatClientsChanged(): void {
    const fn = deps.onWebchatClientsChanged;
    if (!fn) return;
    void Promise.resolve(fn()).catch((e) => configLogger.error(`onWebchatClientsChanged: ${errMsg(e)}`));
  }

  const MAX_PENDING_PER_USER = 50;
  const PENDING_TTL_MS = 5 * 60 * 1000;
  const pendingMessages = new Map<string, { text: string; ts: number }[]>();

  function normalizeParticipantName(participantName?: string): string {
    return typeof participantName === "string" ? participantName.trim() : "";
  }

  function enqueuePending(routeName: string, text: string): void {
    let queue = pendingMessages.get(routeName);
    if (!queue) {
      queue = [];
      pendingMessages.set(routeName, queue);
    }
    queue.push({ text, ts: Date.now() });
    if (queue.length > MAX_PENDING_PER_USER) queue.splice(0, queue.length - MAX_PENDING_PER_USER);
  }

  function flushPending(routeName: string, ws: WebSocket): void {
    const queue = pendingMessages.get(routeName);
    if (!queue || queue.length === 0) return;
    const now = Date.now();
    const valid = queue.filter((m) => now - m.ts < PENDING_TTL_MS);
    pendingMessages.delete(routeName);
    for (const m of valid) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "reply", text: m.text }));
    }
  }

  function bindClient(participantName: string, ws: WebSocket): void {
    const previous = participantByClient.get(ws);
    if (previous && previous !== participantName) {
      const previousSet = clientsByParticipant.get(previous);
      previousSet?.delete(ws);
      if (previousSet && previousSet.size === 0) clientsByParticipant.delete(previous);
    }
    let group = clientsByParticipant.get(participantName);
    if (!group) {
      group = new Set<WebSocket>();
      clientsByParticipant.set(participantName, group);
    }
    group.add(ws);
    participantByClient.set(ws, participantName);
    flushPending(participantName, ws);
  }

  function unbindClient(ws: WebSocket): void {
    const name = participantByClient.get(ws);
    if (!name) return;
    participantByClient.delete(ws);
    const group = clientsByParticipant.get(name);
    group?.delete(ws);
    if (group && group.size === 0) clientsByParticipant.delete(name);
  }

  function handleRegister(participantName: string | undefined, ws: WebSocket): void {
    const routeName = normalizeParticipantName(participantName);
    if (!routeName) return;
    bindClient(routeName, ws);
  }

  function handleChatMessage(text: string, participantName: string | undefined, ws: WebSocket): void {
    const ctx = getWebchatCtx();
    if (!ctx || !text?.trim()) return;
    const routeName = normalizeParticipantName(participantName);
    if (!routeName) {
      ctx.log("warn", "Webchat 上行消息缺少 participantName，已拒绝");
      return;
    }
    bindClient(routeName, ws);
    const tags: ContextTag[] = [
      { kind: "channel", value: "web", groupWith: true },
      { kind: "conv_type", value: "私聊", groupWith: false },
      { kind: "chat_id", value: routeName, groupWith: true, passToTool: true },
    ];
    const msg: AcceptMessage = { content: [textPart(text)], contextTags: tags };
    ctx.accept(msg).catch((err: unknown) => {
      getWebchatCtx()?.log("error", `Failed to send message to Ailo: ${err instanceof Error ? err.message : err}`);
    });
  }

  function recordAiloReply(text: string, participantName: string): boolean {
    const routeName = normalizeParticipantName(participantName);
    if (!routeName) return false;
    const group = clientsByParticipant.get(routeName);
    if (!group || group.size === 0) {
      enqueuePending(routeName, text);
      return true;
    }
    const payload = JSON.stringify({ type: "reply", text });
    let sent = 0;
    for (const client of group) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(payload);
        sent += 1;
      }
    }
    if (sent === 0) {
      enqueuePending(routeName, text);
      return true;
    }
    return true;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${deps.port}`);
    const path = url.pathname;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      if (path === "/" || path === "/index.html") return serveUI(res, deps);
      if (path === "/app.css" || path === "/app.js") return serveStatic(res, path.slice(1));
      if (path === "/chat" && req.method === "GET") return serveChatPage(res, chatHtmlPath);
      // Status
      if (path === "/api/status") return json(res, deps.getConnectionStatus());
      // 运行环境检测与一键安装（供 Skills、代码执行、浏览器等使用）
      if (path === "/api/env/check" && req.method === "GET") return json(res, await getEnvCheck());
      if (path === "/api/env/install" && req.method === "POST") return json(res, await runEnvInstall());
      if (path === "/api/tools" && req.method === "GET") return json(res, await getReportedTools(deps));
      if (path === "/api/skills" && req.method === "GET") return json(res, await getReportedSkills(deps));
      // Ailo 连接配置（仅当 configPath 存在时，供桌面端在界面填写并保存）
      if (deps.configPath) {
        if (path === "/api/connection" && req.method === "GET") return json(res, getConnectionConfig(deps.configPath));
        if (path === "/api/connection" && req.method === "POST") return json(res, await saveConnectionConfig(deps.configPath, await body(req), deps.onConnectionConfigSaved));
      }
      // MCP
      if (path === "/api/mcp" && req.method === "GET") return json(res, getMCPList(deps.mcpManager));
      if (path === "/api/mcp" && req.method === "POST") return json(res, await deps.mcpManager.handle(JSON.parse(await body(req))));
      res.writeHead(404); res.end("Not Found");
    } catch (e: unknown) {
      res.writeHead(500); res.end(JSON.stringify({ error: errMsg(e) }));
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    allChatSockets.add(ws);
    notifyWebchatClientsChanged();
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf-8") : String(data));
        if (msg.type === "register") handleRegister(msg.participantName, ws);
        else if (msg.type === "chat") handleChatMessage(msg.text, msg.participantName, ws);
      } catch {
        getWebchatCtx()?.log("warn", "Failed to parse WebSocket message");
      }
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      allChatSockets.delete(ws);
      unbindClient(ws);
      notifyWebchatClientsChanged();
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://localhost:${deps.port}`);
    if (url.pathname !== "/chat/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const ref: ConfigServerRef = {
    notifyContextAttached() {
      if (deps.onWebchatReady) deps.onWebchatReady({ recordAiloReply });
    },
    hasWebchatPageConnected() {
      return allChatSockets.size > 0;
    },
  };

  server.listen(deps.port, "127.0.0.1", () => {
    configLogger.info(`配置界面: http://127.0.0.1:${deps.port}`);
    if (deps.onWebchatReady && getWebchatCtx()) deps.onWebchatReady({ recordAiloReply });
  });
  server.on("error", (err: unknown) => {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EADDRINUSE") configLogger.info(`端口 ${deps.port} 已被占用，跳过配置界面`);
    else configLogger.error(`启动失败: ${err instanceof Error ? err.message : err}`);
  });
  return ref;
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** 检测 Node（当前进程即 Node，仅取版本） */
function checkNode(): EnvRuntimeItem {
  const v = process.version || "";
  return {
    id: "node",
    name: "Node.js",
    description: "JavaScript 代码执行、MCP、桌面端运行环境",
    ok: true,
    detail: v,
    canAutoInstall: false,
  };
}

/** 检测 Python：优先 python3，其次 python（Windows 上可能是 python） */
function checkPython(): EnvRuntimeItem {
  const commands = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  for (const cmd of commands) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 5000 });
    const out = (r.stdout || r.stderr || "").trim();
    if (r.status === 0 && out) {
      const version = out.replace(/^Python\s+/i, "").split(/\s/)[0]?.trim() || out;
      return {
        id: "python",
        name: "Python",
        description: "代码执行、电子表格等 Skills",
        ok: true,
        detail: version,
        canAutoInstall: false,
      };
    }
  }
  const platform = process.platform;
  let hint: string;
  if (platform === "win32") {
    hint =
      "1. 从官网下载安装包：https://www.python.org/downloads/\n" +
      "2. 安装时务必勾选「Add Python to PATH」\n" +
      "3. 或使用包管理器：winget install Python.Python.3.12\n" +
      "4. 安装后重启终端，执行 python --version 或 py -3 --version 验证";
  } else if (platform === "darwin") {
    hint =
      "1. 推荐使用 Homebrew：brew install python\n" +
      "2. 或从官网下载：https://www.python.org/downloads/\n" +
      "3. 安装后执行 python3 --version 验证";
  } else {
    hint =
      "1. Debian/Ubuntu：sudo apt update && sudo apt install python3 python3-pip\n" +
      "2. Fedora/RHEL：sudo dnf install python3 python3-pip\n" +
      "3. 或从官网下载：https://www.python.org/downloads/\n" +
      "4. 安装后执行 python3 --version 验证";
  }
  return {
    id: "python",
    name: "Python",
    description: "代码执行、电子表格等 Skills",
    ok: false,
    hint,
    canAutoInstall: false,
  };
}

async function getEnvCheck(): Promise<EnvCheckResult> {
  const runtimes: EnvRuntimeItem[] = [checkNode(), checkPython()];
  return { runtimes };
}

/** 安装可自动安装的依赖（当前无内置一键安装项） */
async function runEnvInstall(): Promise<{ installed: string[]; errors: string[] }> {
  return { installed: [], errors: [] };
}

async function getReportedTools(deps: ConfigServerDeps): Promise<{ name: string; description: string; source: string }[]> {
  const out: { name: string; description: string; source: string }[] = [];

  // 内置工具
  if (deps.getEndpointTools) {
    for (const t of deps.getEndpointTools()) {
      out.push({ name: t.name, description: t.description, source: "builtin" });
    }
  }

  // MCP 工具
  for (const t of deps.mcpManager.getAllPrivateTools()) {
    out.push({ name: t.name, description: t.description ?? "", source: "mcp" });
  }
  return out;
}

async function getReportedSkills(deps: ConfigServerDeps): Promise<{ name: string; description: string; source: string }[]> {
  const out: { name: string; description: string; source: string }[] = [];

  if (deps.getEndpointSkills) {
    for (const s of deps.getEndpointSkills()) {
      out.push({ name: s.name, description: s.description, source: "builtin" });
    }
  }

  return out;
}

function getMCPList(mgr: LocalMCPManager) {
  const configs = mgr.getConfigs();
  const servers: Record<string, unknown>[] = [];
  for (const [name, cfg] of configs) {
    const c = cfg as Record<string, unknown>;
    servers.push({
      name,
      transport: c.transport ?? "stdio",
      command: c.command,
      args: c.args,
      url: c.url,
      env: c.env,
      enabled: c.enabled !== false,
      running: mgr.isRunning(name),
      tools: mgr.getToolsForServer(name).map((t) => ({ name: t.name, description: t.description })),
    });
  }
  return { servers };
}

function serveUI(res: ServerResponse, deps: ConfigServerDeps): void {
  try {
    let html = readFileSync(resolveStaticFile("app.html"), "utf-8");
    html = html.replace(/__SHOW_CONNECTION_FORM__/g, String(!!deps.configPath));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e: unknown) {
    res.writeHead(500);
    res.end("Failed to load app.html: " + errMsg(e));
  }
}

function serveStatic(res: ServerResponse, filename: string): void {
  const contentType = filename.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "application/javascript; charset=utf-8";
  try {
    const content = readFileSync(resolveStaticFile(filename), "utf-8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found: " + filename);
  }
}

function getConnectionConfig(configPath: string): {
  configured: boolean;
  ailoWsUrl?: string;
  ailoApiKey?: string;
  endpointId?: string;
} {
  const cfg = readConfig(configPath);
  const url = (getNestedValue(cfg as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
  const key = (getNestedValue(cfg as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
  const id = (getNestedValue(cfg as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
  const configured = !!(url && key && id);
  return {
    configured,
    ailoWsUrl: url || undefined,
    ailoApiKey: key || undefined,
    endpointId: id || undefined,
  };
}

async function saveConnectionConfig(
  configPath: string,
  bodyStr: string,
  onSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string }) => Promise<void>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const bodyTrimmed = (bodyStr ?? "").trim();
    if (!bodyTrimmed) return { ok: false, error: "请求体为空" };
    const existing = readConfig(configPath) as Record<string, unknown>;
    const b = JSON.parse(bodyTrimmed) as { ailoWsUrl?: string; ailoApiKey?: string; endpointId?: string };
    if (b.ailoWsUrl !== undefined) setNestedValue(existing, "ailo.wsUrl", b.ailoWsUrl);
    if (b.ailoApiKey !== undefined) setNestedValue(existing, "ailo.apiKey", b.ailoApiKey);
    if (b.endpointId !== undefined) setNestedValue(existing, "ailo.endpointId", b.endpointId);
    writeConfig(configPath, existing);
    const ailoWsUrl = (getNestedValue(existing as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
    const ailoApiKey = (getNestedValue(existing as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
    const endpointId = (getNestedValue(existing as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
    if (onSaved && ailoWsUrl && ailoApiKey && endpointId) {
      await onSaved({ ailoWsUrl, ailoApiKey, endpointId });
      return { ok: true, message: "已保存，正在使用新配置重连…" };
    }
    return { ok: true, message: "已保存。" };
  } catch (e: unknown) {
    return { ok: false, error: errMsg(e) };
  }
}
