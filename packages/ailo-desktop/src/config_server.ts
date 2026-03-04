import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { WebSocketServer, type WebSocket } from "ws";
import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";
import type { AcceptMessage, ContextTag } from "@lmcl/ailo-endpoint-sdk";
import { textPart, readConfig, writeConfig, getNestedValue, setNestedValue } from "@lmcl/ailo-endpoint-sdk";
import type { LocalMCPManager } from "./mcp_manager.js";
import type { SkillsManager } from "./skills_manager.js";
import { errMsg } from "./utils.js";

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
  skillsManager: SkillsManager;
  getConnectionStatus: () => { connected: boolean; endpointId: string };
  port: number;
  /** config.json path for Ailo connection config */
  configPath?: string;
  /** 蓝图的 URL（与上报给 Ailo 的 blueprints 一致），用于 GET /api/tools 解析内置工具 */
  blueprintUrl?: string;
  /** 远程蓝图 404 时的本地回退路径（绝对路径或相对 cwd） */
  blueprintLocalPath?: string;
  /** 当存在时启用网页聊天：同一端口提供 /chat 与 /chat/ws，并调用 onWebchatReady */
  webchatCtx?: EndpointContext;
  /** 动态获取网页聊天上下文（连接建立后可挂载，无需重启） */
  getWebchatCtx?: () => EndpointContext | null;
  /** 网页聊天就绪后回调，供 index 的 send 工具使用 */
  onWebchatReady?: (api: { recordAiloReply: (text: string, participantName: string, content?: WebchatContentItem[]) => boolean }) => void;
  /** 请求热重连以刷新服务端 Skills 列表（启用/禁用后调用，无需重启） */
  onRequestReconnect?: () => Promise<void>;
  /** 保存 Ailo 连接配置后调用，用于断线后使用新配置重连 */
  onConnectionConfigSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string }) => Promise<void>;
  /** 邮件配置保存后回调，重建邮件通道 */
  onEmailConfigSaved?: () => Promise<void>;
  /** 获取邮件通道状态 */
  getEmailStatus?: () => { configured: boolean; running: boolean };
  /** 飞书配置保存后回调 */
  onFeishuConfigSaved?: () => Promise<void>;
  /** 获取飞书通道状态 */
  getFeishuStatus?: () => { configured: boolean; running: boolean };
  /** 钉钉配置保存后回调 */
  onDingtalkConfigSaved?: () => Promise<void>;
  /** 获取钉钉通道状态 */
  getDingtalkStatus?: () => { configured: boolean; running: boolean };
  /** QQ 配置保存后回调 */
  onQQConfigSaved?: () => Promise<void>;
  /** 获取 QQ 通道状态 */
  getQQStatus?: () => { configured: boolean; running: boolean };
  /** 动态返回当前所有已激活蓝图的本地路径（用于 /api/blueprints 多蓝图展示） */
  getBlueprintPaths?: () => string[];
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
}

export function startConfigServer(deps: ConfigServerDeps): ConfigServerRef {
  const chatHtmlPath = getChatHtmlPath();
  const clientsByParticipant = new Map<string, Set<WebSocket>>();
  const participantByClient = new Map<WebSocket, string>();
  const getWebchatCtx = (): EndpointContext | null => deps.getWebchatCtx?.() ?? deps.webchatCtx ?? null;
  const wss = new WebSocketServer({ noServer: true });

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
      { kind: "channel", value: "网页聊天", groupWith: true },
      { kind: "conv_type", value: "私聊", groupWith: false },
      { kind: "chat_id", value: routeName, groupWith: true, passToTool: true },
      { kind: "participant", value: routeName, groupWith: false },
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
      if (path === "/api/blueprint" && req.method === "GET") return json(res, await getBlueprintInfo(deps));
      if (path === "/api/blueprints" && req.method === "GET") return json(res, await getAllBlueprintsInfo(deps));
      // Ailo 连接配置（仅当 configPath 存在时，供桌面端在界面填写并保存）
      if (deps.configPath) {
        if (path === "/api/connection" && req.method === "GET") return json(res, getConnectionConfig(deps.configPath));
        if (path === "/api/connection" && req.method === "POST") return json(res, await saveConnectionConfig(deps.configPath, await body(req), deps.onConnectionConfigSaved));
      }
      // 邮件配置
      if (deps.configPath) {
        if (path === "/api/email/config" && req.method === "GET") return json(res, getEmailConfig(deps.configPath, deps.getEmailStatus));
        if (path === "/api/email/config" && req.method === "POST") return json(res, await saveEmailConfig(deps.configPath, await body(req), deps.onEmailConfigSaved));
      }
      // 飞书配置
      if (deps.configPath) {
        if (path === "/api/feishu/config" && req.method === "GET") return json(res, getPlatformConfig(deps.configPath, "feishu", ["appId", "appSecret"], deps.getFeishuStatus));
        if (path === "/api/feishu/config" && req.method === "POST") return json(res, await savePlatformConfig(deps.configPath, "feishu", ["appId", "appSecret"], await body(req), deps.onFeishuConfigSaved));
      }
      // 钉钉配置
      if (deps.configPath) {
        if (path === "/api/dingtalk/config" && req.method === "GET") return json(res, getPlatformConfig(deps.configPath, "dingtalk", ["clientId", "clientSecret"], deps.getDingtalkStatus));
        if (path === "/api/dingtalk/config" && req.method === "POST") return json(res, await savePlatformConfig(deps.configPath, "dingtalk", ["clientId", "clientSecret"], await body(req), deps.onDingtalkConfigSaved));
      }
      // QQ 配置
      if (deps.configPath) {
        if (path === "/api/qq/config" && req.method === "GET") return json(res, getPlatformConfig(deps.configPath, "qq", ["appId", "appSecret", "apiBase"], deps.getQQStatus));
        if (path === "/api/qq/config" && req.method === "POST") return json(res, await savePlatformConfig(deps.configPath, "qq", ["appId", "appSecret", "apiBase"], await body(req), deps.onQQConfigSaved));
      }
      // MCP
      if (path === "/api/mcp" && req.method === "GET") return json(res, getMCPList(deps.mcpManager));
      if (path === "/api/mcp" && req.method === "POST") return json(res, await deps.mcpManager.handle(JSON.parse(await body(req))));
      // Skills
      if (path === "/api/skills" && req.method === "GET") return json(res, { skills: await deps.skillsManager.listAll() });
      if (path === "/api/skills" && req.method === "POST") { const b = JSON.parse(await body(req)); await deps.skillsManager.createSkill(b.name, b.content); return json(res, { ok: true }); }
      if (path === "/api/skills/hub/install" && req.method === "POST") { const b = JSON.parse(await body(req)); const bundle = await deps.skillsManager.installFromHub(b.url, b.enable !== false); deps.onRequestReconnect?.().catch(() => {}); return json(res, { ok: true, name: bundle.name }); }
      if (path.match(/^\/api\/skills\/([^/]+)\/enable$/) && req.method === "POST") { const n = path.split("/")[3]; await deps.skillsManager.enableSkill(n, true); deps.onRequestReconnect?.().catch(() => {}); return json(res, { ok: true }); }
      if (path.match(/^\/api\/skills\/([^/]+)\/disable$/) && req.method === "POST") { const n = path.split("/")[3]; await deps.skillsManager.disableSkill(n); deps.onRequestReconnect?.().catch(() => {}); return json(res, { ok: true }); }
      if (path.match(/^\/api\/skills\/([^/]+)$/) && req.method === "DELETE") { const n = path.split("/")[3]; await deps.skillsManager.deleteSkill(n); deps.onRequestReconnect?.().catch(() => {}); return json(res, { ok: true }); }
      if (path.match(/^\/api\/skills\/([^/]+)\/content$/) && req.method === "GET") { const n = path.split("/")[3]; return json(res, { content: await deps.skillsManager.getSkillContent(n) }); }
      if (path === "/api/skills/reconnect" && req.method === "POST") {
        try {
          if (deps.onRequestReconnect) { await deps.onRequestReconnect(); return json(res, { ok: true, message: "已重连，Skills 已同步" }); }
          return json(res, { ok: false, error: "端点未连接，重连仅在有连接时可用" });
        } catch (e: unknown) {
          return json(res, { ok: false, error: errMsg(e) });
        }
      }
      res.writeHead(404); res.end("Not Found");
    } catch (e: unknown) {
      res.writeHead(500); res.end(JSON.stringify({ error: errMsg(e) }));
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf-8") : String(data));
        if (msg.type === "register") handleRegister(msg.participantName, ws);
        else if (msg.type === "chat") handleChatMessage(msg.text, msg.participantName, ws);
      } catch {
        getWebchatCtx()?.log("warn", "Failed to parse WebSocket message");
      }
    });
    ws.on("close", () => unbindClient(ws));
    ws.on("error", () => unbindClient(ws));
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
  };

  server.listen(deps.port, "127.0.0.1", () => {
    console.log(`[config] 配置界面: http://127.0.0.1:${deps.port}`);
    if (deps.onWebchatReady && getWebchatCtx()) deps.onWebchatReady({ recordAiloReply });
  });
  server.on("error", (err: unknown) => {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EADDRINUSE") console.log(`[config] 端口 ${deps.port} 已被占用，跳过配置界面`);
    else console.error("[config] 启动失败:", err instanceof Error ? err.message : err);
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
        description: "代码执行、文档编辑 / 演示文稿 / 电子表格等 Skills",
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
    description: "代码执行、文档编辑 / 演示文稿 / 电子表格等 Skills",
    ok: false,
    hint,
    canAutoInstall: false,
  };
}

/** 检测 Playwright Chromium 是否已安装 */
async function checkPlaywright(): Promise<EnvRuntimeItem> {
  try {
    const playwright = await import("playwright");
    const exe = playwright.chromium.executablePath();
    if (existsSync(exe)) {
      return {
        id: "playwright",
        name: "Playwright Chromium",
        description: "浏览器自动化、可见窗口操作、网页抓取等",
        ok: true,
        detail: "已安装",
        canAutoInstall: true,
      };
    }
  } catch { }
  return {
    id: "playwright",
    name: "Playwright Chromium",
    description: "浏览器自动化、可见窗口操作、网页抓取等",
    ok: false,
    hint:
      "本依赖支持一键安装。\n\n" +
      "点击本页下方「安装缺失依赖」按钮，将自动执行 npx playwright install chromium 下载 Chromium 浏览器。\n\n" +
      "若需手动安装：在项目目录或任意目录执行 npx playwright install chromium。",
    canAutoInstall: true,
  };
}

/** 检测 LibreOffice（document-editing / presentation 转 PDF、PPT 预览等可选依赖） */
function checkLibreOffice(): EnvRuntimeItem {
  const commands = ["soffice", "libreoffice"];
  for (const cmd of commands) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (r.status === 0 && (r.stdout || r.stderr || "").trim()) {
      const out = (r.stdout || r.stderr || "").trim();
      return {
        id: "libreoffice",
        name: "LibreOffice",
        description: "Word/PPT 转 PDF、演示文稿预览等（document-editing / presentation）",
        ok: true,
        detail: out.split(/\n/)[0]?.trim() || "已安装",
        canAutoInstall: false,
      };
    }
  }
  const platform = process.platform;
  let hint: string;
  if (platform === "win32") {
    hint =
      "LibreOffice 用于 Word/PPT 转 PDF、演示文稿预览等（document-editing、presentation Skills）。\n\n" +
      "1. 打开官网下载页：https://www.libreoffice.org/download\n" +
      "2. 选择 Windows 版本，下载安装包并运行安装程序\n" +
      "3. 安装完成后，确保「LibreOffice」或 soffice 已加入系统 PATH（通常自动配置）\n" +
      "4. 在终端执行 soffice --version 验证";
  } else if (platform === "darwin") {
    hint =
      "LibreOffice 用于 Word/PPT 转 PDF、演示文稿预览等（document-editing、presentation Skills）。\n\n" +
      "1. 执行：brew install --cask libreoffice\n" +
      "2. 安装完成后在终端执行 libreoffice --version 或 soffice --version 验证";
  } else {
    hint =
      "LibreOffice 用于 Word/PPT 转 PDF、演示文稿预览等（document-editing、presentation Skills）。\n\n" +
      "1. Debian/Ubuntu：sudo apt install libreoffice\n" +
      "2. Fedora/RHEL：sudo dnf install libreoffice\n" +
      "3. 安装后在终端执行 soffice --version 或 libreoffice --version 验证";
  }
  return {
    id: "libreoffice",
    name: "LibreOffice",
    description: "Word/PPT 转 PDF、演示文稿预览等（document-editing / presentation）",
    ok: false,
    hint,
    canAutoInstall: false,
  };
}

async function getEnvCheck(): Promise<EnvCheckResult> {
  const playwright = await checkPlaywright();
  const runtimes: EnvRuntimeItem[] = [
    checkNode(),
    checkPython(),
    playwright,
    checkLibreOffice(),
  ];
  return { runtimes };
}

/** 安装可自动安装的依赖（目前仅 Playwright Chromium） */
async function runEnvInstall(): Promise<{ installed: string[]; errors: string[] }> {
  const { execSync } = await import("child_process");
  const installed: string[] = [];
  const errors: string[] = [];
  try {
    execSync("npx playwright install chromium", { stdio: "pipe", timeout: 120000, encoding: "utf-8" });
    installed.push("Playwright Chromium");
  } catch (e: unknown) {
    errors.push(`Playwright: ${errMsg(e)}`);
  }
  return { installed, errors };
}

/** 从蓝图正文中解析 tools 列表（仅提取 name、description） */
function parseBlueprintTools(md: string): { name: string; description: string }[] {
  const tools: { name: string; description: string }[] = [];
  const frontmatterMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const yaml = frontmatterMatch?.[1] ?? "";
  let inToolsSection = false;
  let current: { name: string; description: string } | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trim() === "tools:") {
      inToolsSection = true;
      continue;
    }
    if (!inToolsSection) continue;
    const itemMatch = line.match(/^\s+-\s+name:\s*(.+)$/);
    const descMatch = line.match(/^\s+description:\s*(.+)$/);
    if (itemMatch) {
      if (current) tools.push(current);
      current = { name: itemMatch[1].trim(), description: "" };
    } else if (current && descMatch) {
      current.description = descMatch[1].trim();
    }
  }
  if (current) tools.push(current);
  return tools;
}

async function fetchBlueprintContent(url: string, localFallbackPath?: string): Promise<string> {
  if (url.startsWith("file://")) {
    const filePath = url.slice(7);
    return readFileSync(filePath, "utf-8");
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Blueprint fetch failed: ${res.status}`);
    return res.text();
  } catch (e) {
    if (localFallbackPath && existsSync(localFallbackPath)) {
      return readFileSync(localFallbackPath, "utf-8");
    }
    throw e;
  }
}

async function getReportedTools(deps: ConfigServerDeps): Promise<{ name: string; description: string; source: string }[]> {
  const out: { name: string; description: string; source: string }[] = [];
  if (deps.blueprintUrl) {
    try {
      const localPath = deps.blueprintLocalPath
        ? resolve(process.cwd(), deps.blueprintLocalPath)
        : undefined;
      const md = await fetchBlueprintContent(deps.blueprintUrl, localPath);
      for (const t of parseBlueprintTools(md)) {
        out.push({ name: t.name, description: t.description, source: "builtin" });
      }
    } catch (e) {
      console.error("[config] 解析蓝图工具失败:", e);
    }
  }
  for (const t of deps.mcpManager.getAllPrivateTools()) {
    out.push({ name: t.name, description: t.description ?? "", source: "mcp" });
  }
  return out;
}

async function getBlueprintInfo(deps: ConfigServerDeps): Promise<{ url: string | null; content: string | null }> {
  if (!deps.blueprintUrl) return { url: null, content: null };
  try {
    const localPath = deps.blueprintLocalPath ? resolve(process.cwd(), deps.blueprintLocalPath) : undefined;
    const content = await fetchBlueprintContent(deps.blueprintUrl, localPath);
    return { url: deps.blueprintUrl, content };
  } catch {
    return { url: deps.blueprintUrl, content: null };
  }
}

async function getAllBlueprintsInfo(deps: ConfigServerDeps): Promise<{ name: string; path: string; content: string | null }[]> {
  const paths = deps.getBlueprintPaths?.() ?? [];
  if (paths.length === 0) {
    // fallback：如果没有传 getBlueprintPaths，至少返回主蓝图
    if (deps.blueprintUrl) {
      try {
        const localPath = deps.blueprintLocalPath ? resolve(process.cwd(), deps.blueprintLocalPath) : undefined;
        const content = await fetchBlueprintContent(deps.blueprintUrl, localPath);
        const name = basename(deps.blueprintLocalPath ?? deps.blueprintUrl, ".blueprint.md");
        return [{ name, path: deps.blueprintUrl, content }];
      } catch {
        return [];
      }
    }
    return [];
  }
  return Promise.all(
    paths.map(async (p) => {
      const filePath = p.startsWith("file://") ? p.slice(7) : p;
      const name = basename(filePath, ".blueprint.md");
      try {
        const content = readFileSync(filePath, "utf-8");
        return { name, path: p, content };
      } catch {
        return { name, path: p, content: null };
      }
    }),
  );
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

function getEmailConfig(
  configPath: string,
  getStatus?: () => { configured: boolean; running: boolean },
): Record<string, unknown> {
  const cfg = readConfig(configPath) as Record<string, unknown>;
  const email = (cfg.email ?? {}) as Record<string, unknown>;
  const status = getStatus?.() ?? { configured: false, running: false };
  return {
    imapHost: email.imapHost ?? "",
    imapUser: email.imapUser ?? "",
    imapPassword: email.imapPassword ?? "",
    imapPort: email.imapPort ?? 993,
    smtpHost: email.smtpHost ?? "",
    smtpPort: email.smtpPort ?? 465,
    smtpUser: email.smtpUser ?? "",
    smtpPassword: email.smtpPassword ?? "",
    ...status,
  };
}

async function saveEmailConfig(
  configPath: string,
  bodyStr: string,
  onSaved?: () => Promise<void>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const bodyTrimmed = (bodyStr ?? "").trim();
    if (!bodyTrimmed) return { ok: false, error: "请求体为空" };
    const existing = readConfig(configPath) as Record<string, unknown>;
    const b = JSON.parse(bodyTrimmed) as Record<string, unknown>;
    const emailFields = ["imapHost", "imapUser", "imapPassword", "imapPort", "smtpHost", "smtpPort", "smtpUser", "smtpPassword"];
    for (const field of emailFields) {
      if (b[field] !== undefined) setNestedValue(existing, `email.${field}`, b[field]);
    }
    writeConfig(configPath, existing);
    if (onSaved) {
      await onSaved();
      return { ok: true, message: "已保存，邮件通道正在重启…" };
    }
    return { ok: true, message: "已保存。" };
  } catch (e: unknown) {
    return { ok: false, error: errMsg(e) };
  }
}

function getPlatformConfig(
  configPath: string,
  platform: string,
  fields: string[],
  getStatus?: () => { configured: boolean; running: boolean },
): Record<string, unknown> {
  const cfg = readConfig(configPath) as Record<string, unknown>;
  const section = (cfg[platform] ?? {}) as Record<string, unknown>;
  const status = getStatus?.() ?? { configured: false, running: false };
  const result: Record<string, unknown> = { ...status };
  for (const f of fields) {
    result[f] = section[f] ?? "";
  }
  return result;
}

async function savePlatformConfig(
  configPath: string,
  platform: string,
  fields: string[],
  bodyStr: string,
  onSaved?: () => Promise<void>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const bodyTrimmed = (bodyStr ?? "").trim();
    if (!bodyTrimmed) return { ok: false, error: "请求体为空" };
    const existing = readConfig(configPath) as Record<string, unknown>;
    const b = JSON.parse(bodyTrimmed) as Record<string, unknown>;
    for (const field of fields) {
      if (b[field] !== undefined) setNestedValue(existing, `${platform}.${field}`, b[field]);
    }
    writeConfig(configPath, existing);
    if (onSaved) {
      await onSaved();
      return { ok: true, message: "已保存，通道正在重启…" };
    }
    return { ok: true, message: "已保存。" };
  } catch (e: unknown) {
    return { ok: false, error: errMsg(e) };
  }
}