import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { WebSocketServer, type WebSocket } from "ws";
import type { EndpointContext } from "@lmcl/ailo-endpoint-sdk";
import type { AcceptMessage, ContextTag } from "@lmcl/ailo-endpoint-sdk";
import { textPart, readConfig, writeConfig, mergeWithEnv, AILO_ENV_MAPPING, getNestedValue, setNestedValue } from "@lmcl/ailo-endpoint-sdk";
import type { EnvMapping } from "@lmcl/ailo-endpoint-sdk";
import type { LocalMCPManager } from "./mcp_manager.js";
import type { SkillsManager } from "./skills_manager.js";

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
  getConnectionStatus: () => { connected: boolean; endpointId: string; displayName: string };
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
  onWebchatReady?: (api: { recordAiloReply: (text: string, participantName: string) => boolean }) => void;
  /** 请求热重连以刷新云端 Skills 列表（启用/禁用后调用，无需重启） */
  onRequestReconnect?: () => Promise<void>;
  /** 保存 Ailo 连接配置后调用，用于断线后使用新配置重连 */
  onConnectionConfigSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string; displayName?: string }) => Promise<void>;
}

function getChatHtmlPath(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const inStatic = join(base, "static", "chat.html");
  if (existsSync(inStatic)) return inStatic;
  return join(base, "..", "src", "static", "chat.html");
}

function serveChatPage(res: ServerResponse, htmlPath: string): void {
  try {
    const html = readFileSync(htmlPath, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500);
    res.end("Failed to load chat page: " + msg);
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

  function normalizeParticipantName(participantName?: string): string {
    return typeof participantName === "string" ? participantName.trim() : "";
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
  }

  function unbindClient(ws: WebSocket): void {
    const name = participantByClient.get(ws);
    if (!name) return;
    participantByClient.delete(ws);
    const group = clientsByParticipant.get(name);
    group?.delete(ws);
    if (group && group.size === 0) clientsByParticipant.delete(name);
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
    if (!group || group.size === 0) return false;
    const payload = JSON.stringify({ type: "reply", text });
    let sent = 0;
    for (const client of group) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(payload);
        sent += 1;
      }
    }
    return sent > 0;
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
      if (path === "/chat" && req.method === "GET") return serveChatPage(res, chatHtmlPath);
      // Status
      if (path === "/api/status") return json(res, deps.getConnectionStatus());
      // 运行环境检测与一键安装（供 Skills、代码执行、浏览器等使用）
      if (path === "/api/env/check" && req.method === "GET") return json(res, await getEnvCheck());
      if (path === "/api/env/install" && req.method === "POST") return json(res, await runEnvInstall());
      if (path === "/api/tools" && req.method === "GET") return json(res, await getReportedTools(deps));
      if (path === "/api/blueprint" && req.method === "GET") return json(res, await getBlueprintInfo(deps));
      // Ailo 连接配置（仅当 configPath 存在时，供桌面端在界面填写并保存）
      if (deps.configPath) {
        if (path === "/api/connection" && req.method === "GET") return json(res, getConnectionConfig(deps.configPath));
        if (path === "/api/connection" && req.method === "POST") return json(res, await saveConnectionConfig(deps.configPath, await body(req), deps.onConnectionConfigSaved));
      }
      // MCP
      if (path === "/api/mcp" && req.method === "GET") return json(res, getMCPList(deps.mcpManager));
      if (path === "/api/mcp" && req.method === "POST") return json(res, await deps.mcpManager.handle(JSON.parse(await body(req))));
      // Skills
      if (path === "/api/skills" && req.method === "GET") return json(res, { skills: await deps.skillsManager.listAll() });
      if (path === "/api/skills" && req.method === "POST") { const b = JSON.parse(await body(req)); await deps.skillsManager.createSkill(b.name, b.content); return json(res, { ok: true }); }
      if (path === "/api/skills/hub/install" && req.method === "POST") { const b = JSON.parse(await body(req)); const bundle = await deps.skillsManager.installFromHub(b.url, b.enable !== false); return json(res, { ok: true, name: bundle.name }); }
      if (path.match(/^\/api\/skills\/([^/]+)\/enable$/) && req.method === "POST") { const n = path.split("/")[3]; await deps.skillsManager.enableSkill(n, true); return json(res, { ok: true }); }
      if (path.match(/^\/api\/skills\/([^/]+)\/disable$/) && req.method === "POST") { const n = path.split("/")[3]; await deps.skillsManager.disableSkill(n); return json(res, { ok: true }); }
      if (path.match(/^\/api\/skills\/([^/]+)$/) && req.method === "DELETE") { const n = path.split("/")[3]; await deps.skillsManager.deleteSkill(n); return json(res, { ok: true }); }
      if (path.match(/^\/api\/skills\/([^/]+)\/content$/) && req.method === "GET") { const n = path.split("/")[3]; return json(res, { content: await deps.skillsManager.getSkillContent(n) }); }
      if (path === "/api/skills/reconnect" && req.method === "POST") {
        try {
          if (deps.onRequestReconnect) { await deps.onRequestReconnect(); return json(res, { ok: true, message: "已重连，云端 Skills 已更新" }); }
          return json(res, { ok: false, error: "端点未连接，重连仅在有连接时可用" });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "重连失败";
          return json(res, { ok: false, error: msg });
        }
      }
      res.writeHead(404); res.end("Not Found");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500); res.end(JSON.stringify({ error: msg }));
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString() : String(data));
        if (msg.type === "chat") handleChatMessage(msg.text, msg.participantName, ws);
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
  } catch {}
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
  const commands = process.platform === "win32" ? ["soffice", "libreoffice"] : ["soffice", "libreoffice"];
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

/** 检测 himalaya CLI（邮件 Skill 可选依赖） */
function checkHimalaya(): EnvRuntimeItem {
  const r = spawnSync("himalaya", ["--version"], { encoding: "utf-8", timeout: 3000 });
  if (r.status === 0 || (r.stdout || r.stderr || "").trim()) {
    const out = (r.stdout || r.stderr || "").trim();
    return {
      id: "himalaya",
      name: "himalaya",
      description: "邮件 Skill（IMAP/SMTP 收发、附件）",
      ok: true,
      detail: out.split(/\n/)[0]?.trim() || "已安装",
      canAutoInstall: false,
    };
  }
  const platform = process.platform;
  let hint: string;
  if (platform === "win32") {
    hint =
      "himalaya 是命令行邮件客户端，用于邮件 Skill（IMAP/SMTP 收发、附件）。\n\n" +
      "1. 若已安装 Scoop，执行：scoop install himalaya\n" +
      "2. 未安装 Scoop 可先执行：Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser；然后 irm get.scoop.sh | iex\n" +
      "3. 安装后在终端执行 himalaya --version 验证\n" +
      "4. 需在 ~/.config/himalaya/config.toml 中配置邮箱账户。详见 https://github.com/soywod/himalaya";
  } else if (platform === "darwin") {
    hint =
      "himalaya 是命令行邮件客户端，用于邮件 Skill（IMAP/SMTP 收发、附件）。\n\n" +
      "1. 执行：brew install himalaya\n" +
      "2. 安装后在终端执行 himalaya --version 验证\n" +
      "3. 需在 ~/.config/himalaya/config.toml 中配置邮箱账户。详见 https://github.com/soywod/himalaya";
  } else {
    hint =
      "himalaya 是命令行邮件客户端，用于邮件 Skill（IMAP/SMTP 收发、附件）。\n\n" +
      "1. 一键安装：curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | bash\n" +
      "2. 或从 GitHub Releases 下载对应架构的二进制：https://github.com/soywod/himalaya/releases\n" +
      "3. 安装后在终端执行 himalaya --version 验证\n" +
      "4. 需在 ~/.config/himalaya/config.toml 中配置邮箱账户。详见 https://github.com/soywod/himalaya";
  }
  return {
    id: "himalaya",
    name: "himalaya",
    description: "邮件 Skill（IMAP/SMTP 收发、附件）",
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
    checkHimalaya(),
  ];
  return { runtimes };
}

/** 安装可自动安装的依赖（目前仅 Playwright Chromium） */
async function runEnvInstall(): Promise<{ installed: string[]; errors: string[] }> {
  const { execSync } = await import("child_process");
  const installed: string[] = [];
  const errors: string[] = [];
  try {
    execSync("npx playwright install chromium", { stdio: "pipe", timeout: 120000 });
    installed.push("Playwright Chromium");
  } catch (e: any) {
    errors.push(`Playwright: ${e?.message || "安装失败"}`);
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

function getMCPList(mgr: LocalMCPManager) {
  const configs = mgr.getConfigs();
  const servers: any[] = [];
  for (const [name, cfg] of configs) {
    servers.push({ name, command: (cfg as any).command, args: (cfg as any).args, enabled: (cfg as any).enabled !== false, running: mgr.isRunning(name), tools: mgr.getToolsForServer(name).map((t) => ({ name: t.name, description: t.description })) });
  }
  return { servers };
}

function serveUI(res: ServerResponse, deps: ConfigServerDeps): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(getUIHTML(!!deps.configPath));
}

function getConnectionConfig(configPath: string): {
  configured: boolean;
  ailoWsUrl?: string;
  ailoApiKey?: string;
  endpointId?: string;
  displayName?: string;
} {
  const cfg = readConfig(configPath);
  const { merged } = mergeWithEnv(cfg, AILO_ENV_MAPPING);
  const url = (getNestedValue(merged as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
  const key = (getNestedValue(merged as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
  const id = (getNestedValue(merged as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
  const configured = !!(url && key && id);
  return {
    configured,
    ailoWsUrl: url || undefined,
    ailoApiKey: key || undefined,
    endpointId: id || undefined,
    displayName: (getNestedValue(merged as Record<string, unknown>, "ailo.displayName") as string) || undefined,
  };
}

async function saveConnectionConfig(
  configPath: string,
  bodyStr: string,
  onSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string; displayName?: string }) => Promise<void>,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const bodyTrimmed = (bodyStr ?? "").trim();
    if (!bodyTrimmed) return { ok: false, error: "请求体为空" };
    const existing = readConfig(configPath) as Record<string, unknown>;
    const b = JSON.parse(bodyTrimmed) as { ailoWsUrl?: string; ailoApiKey?: string; endpointId?: string; displayName?: string };
    if (b.ailoWsUrl !== undefined) setNestedValue(existing, "ailo.wsUrl", b.ailoWsUrl);
    if (b.ailoApiKey !== undefined) setNestedValue(existing, "ailo.apiKey", b.ailoApiKey);
    if (b.endpointId !== undefined) setNestedValue(existing, "ailo.endpointId", b.endpointId);
    if (b.displayName !== undefined) setNestedValue(existing, "ailo.displayName", b.displayName);
    writeConfig(configPath, existing);
    const { merged } = mergeWithEnv(existing, AILO_ENV_MAPPING);
    const ailoWsUrl = (getNestedValue(merged as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
    const ailoApiKey = (getNestedValue(merged as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
    const endpointId = (getNestedValue(merged as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
    const displayName = (getNestedValue(merged as Record<string, unknown>, "ailo.displayName") as string) ?? undefined;
    if (onSaved && ailoWsUrl && ailoApiKey && endpointId) {
      await onSaved({ ailoWsUrl, ailoApiKey, endpointId, displayName });
      return { ok: true, message: "已保存，正在使用新配置重连…" };
    }
    return { ok: true, message: "已保存。" };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function getUIHTML(showConnectionForm: boolean): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ailo Desktop</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
  background:#1a1d24;
  color:#d4d6da;
  min-height:100vh;
  font-size:15px;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
.container{max-width:960px;margin:0 auto;padding:24px}
h1{font-size:1.35rem;font-weight:600;margin-bottom:20px;display:flex;align-items:center;gap:10px;color:#e2e4e8}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.on{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.4)}
.dot.off{background:#f87171}
.tabs{display:flex;gap:6px;margin-bottom:20px;border-bottom:1px solid #333842;padding-bottom:10px;flex-wrap:wrap}
.tab{
  padding:8px 18px;
  border-radius:8px 8px 0 0;
  cursor:pointer;
  font-size:15px;
  color:#9ca3af;
  border:1px solid transparent;
  transition:color .15s,background .15s;
}
.tab.active{color:#e2e4e8;background:#252830;border-color:#333842;border-bottom-color:#252830}
.tab:hover{color:#d1d5db}
.panel{display:none} .panel.active{display:block}
.card{
  background:#252830;
  border:1px solid #333842;
  border-radius:12px;
  padding:20px;
  margin-bottom:16px;
}
.card h2{font-size:1.05rem;margin-bottom:12px;color:#b4b8be;font-weight:600}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:13px;font-weight:500}
.badge.on{background:rgba(52,211,153,.18);color:#6ee7b7}
.badge.off{background:rgba(248,113,113,.18);color:#fca5a5}
.badge.builtin{background:rgba(59,130,246,.2);color:#93c5fd}
.badge.custom{background:rgba(168,85,247,.2);color:#c4b5fd}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:10px 12px;border-bottom:1px solid #333842;color:#9ca3af;font-weight:500;font-size:14px}
td{padding:10px 12px;border-bottom:1px solid #2d3139;color:#d4d6da}
.btn{padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-size:14px;margin-right:6px;transition:opacity .15s,transform .05s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
.btn-danger{background:#dc2626;color:#fff}
.btn-danger:hover{background:#b91c1c}
.btn-sm{padding:6px 12px;font-size:13px}
.btn-success{background:#059669;color:#fff}
.info-row{display:flex;gap:24px;margin-bottom:8px;font-size:15px}
.info-label{color:#9ca3af;min-width:100px}
.info-value{color:#d4d6da}
.env-hint{font-size:13px;color:#9ca3af;margin-top:6px;line-height:1.5;word-break:break-word}
.env-table th:nth-child(1){width:140px}
.env-table th:nth-child(2){min-width:200px}
.env-table th:nth-child(3){width:160px}
.env-table th:nth-child(4){width:100px}
.env-hint-toggle{background:none;border:none;color:#60a5fa;cursor:pointer;font-size:13px;padding:0;text-decoration:underline}
.env-hint-toggle:hover{color:#93c5fd}
input,textarea,select{
  background:#1a1d24;
  border:1px solid #333842;
  color:#e2e4e8;
  padding:10px 14px;
  border-radius:8px;
  font-size:15px;
  width:100%;
  transition:border-color .15s;
}
input:focus,textarea:focus,select:focus{outline:none;border-color:#4b5563}
textarea{min-height:88px;font-family:inherit;resize:vertical;line-height:1.5}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:14px;color:#9ca3af;margin-bottom:6px}
.skill-card{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #2d3139}
.skill-card:last-child{border-bottom:none}
.toggle{position:relative;width:38px;height:22px;display:inline-block}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#4b5563;border-radius:11px;transition:.25s}
.toggle input:checked+.slider{background:#059669}
.toggle .slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.25s}
.toggle input:checked+.slider:before{transform:translateX(16px)}
.tools-sub-nav{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid #333842;padding-bottom:8px}
.tools-sub-btn{padding:8px 16px;border-radius:8px;border:1px solid transparent;cursor:pointer;font-size:14px;color:#9ca3af;background:transparent;transition:color .15s,background .15s}
.tools-sub-btn:hover{color:#d1d5db}
.tools-sub-btn.active{color:#e2e4e8;background:#252830;border-color:#333842}
.tools-sub-panel{display:none}
.tools-sub-panel.active{display:block}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:100;display:none;backdrop-filter:blur(4px)}
.modal{background:#252830;border:1px solid #333842;border-radius:14px;padding:28px;max-width:500px;width:90%;box-shadow:0 20px 50px rgba(0,0,0,.4)}
.modal h3{margin-bottom:18px;font-size:1.1rem;color:#e2e4e8}
pre{font-size:14px;line-height:1.5}
code{font-size:14px;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.25)}
</style>
</head>
<body>
<div class="container">
  <h1><span class="dot off" id="dot"></span> Ailo Desktop <span id="statusText" style="font-size:14px;color:#9ca3af"></span></h1>
  <div class="tabs">
    <div class="tab active" onclick="showTab('chat')">网页聊天</div>
    <div class="tab" onclick="showTab('status')">状态</div>
    <div class="tab" onclick="showTab('tools')">工具</div>
    <div class="tab" onclick="showTab('mcp')">MCP</div>
    <div class="tab" onclick="showTab('skills')">Skills</div>
    <div class="tab" onclick="showTab('env')">运行环境</div>
  </div>

  <div class="panel active" id="panel-chat">
    <div class="card">
      <h2>网页聊天</h2>
      <p style="font-size:14px;color:#9ca3af;margin-bottom:12px">与 Ailo 对话的网页聊天界面，需先配置并连接 Ailo 后使用。</p>
      <iframe src="/chat" title="网页聊天" style="width:100%;height:70vh;min-height:400px;border:1px solid #333842;border-radius:10px;background:#1a1d24"></iframe>
    </div>
  </div>

  <div class="panel" id="panel-status">
    <div class="card"><h2>连接状态</h2><div id="statusInfo">加载中...</div></div>
    <div class="card" id="connectionFormCard" style="${showConnectionForm ? "" : "display:none"}">
      <h2>Ailo 连接配置</h2>
      <p style="font-size:14px;color:#9ca3af;margin-bottom:14px">填写后点击保存，将自动断线并使用新配置重连；连不上会退避重试。</p>
      <div class="form-group"><label>AILO_WS_URL</label><input id="connWsUrl" placeholder="ws://127.0.0.1:19800/ws"></div>
      <div class="form-group"><label>AILO_API_KEY</label><input id="connApiKey" type="text" placeholder="ailo_ep_xxx" autocomplete="off"></div>
      <div class="form-group"><label>AILO_ENDPOINT_ID</label><input id="connEndpointId" placeholder="desktop-01"></div>
      <div class="form-group"><label>DISPLAY_NAME（可选）</label><input id="connDisplayName" placeholder="我的桌面"></div>
      <button class="btn btn-primary" onclick="saveConnection()">保存</button>
      <span id="connectionSaveMsg" style="margin-left:10px;font-size:14px;color:#9ca3af"></span>
    </div>
  </div>

  <div class="panel" id="panel-tools">
    <div class="tools-sub-nav">
      <button type="button" class="tools-sub-btn active" data-tools-sub="reported" onclick="showToolsSubTab('reported')">已上报工具</button>
      <button type="button" class="tools-sub-btn" data-tools-sub="blueprint" onclick="showToolsSubTab('blueprint')">蓝图</button>
    </div>
    <div class="tools-sub-panel active" data-tools-sub="reported">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h2>已上报工具</h2>
          <button class="btn btn-primary btn-sm" onclick="loadReportedTools()">刷新</button>
        </div>
        <p style="font-size:14px;color:#9ca3af;margin-bottom:12px">桌面端向 Ailo 注册的能力（蓝图 + MCP），可直接在对话中让 Ailo 调用</p>
        <div id="reportedToolsList">加载中...</div>
      </div>
    </div>
    <div class="tools-sub-panel" data-tools-sub="blueprint">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h2>蓝图</h2>
          <button class="btn btn-primary btn-sm" onclick="loadBlueprint()">刷新</button>
        </div>
        <p style="font-size:14px;color:#9ca3af;margin-bottom:12px">当前端点使用的桌面端蓝图，定义内置工具列表并上报给 Ailo</p>
        <div id="blueprintUrlDisplay" style="font-size:14px;color:#9ca3af;margin-bottom:10px">-</div>
        <pre id="blueprintContent" style="max-height:60vh;overflow:auto;font-size:14px;line-height:1.5;white-space:pre-wrap;background:#1a1d24;padding:14px;border-radius:8px;border:1px solid #333842;margin:0">切换到此 Tab 后自动加载</pre>
      </div>
    </div>
  </div>

  <div class="panel" id="panel-mcp">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2>MCP 服务</h2>
        <div><button class="btn btn-primary btn-sm" onclick="showMCPCreateModal()">新增</button> <button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="loadMCP()">刷新</button></div>
      </div>
      <p style="font-size:14px;color:#9ca3af;margin-bottom:12px">配置保存在 <code>~/.agents/mcp_config.json</code>，新增后需点击「启动」才会连上并上报工具给 Ailo</p>
      <div id="mcpList">加载中...</div>
    </div>
  </div>

  <div class="panel" id="panel-skills">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2>Skills</h2>
        <div><button class="btn btn-primary btn-sm" id="skillsReconnectBtn" onclick="doSkillsReconnect()" title="启用/禁用 Skill 后点击，使云端立即生效，无需重启">重连以刷新 Skills</button> <button class="btn btn-primary btn-sm" onclick="showInstallModal()">从市场安装</button> <button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="showCreateModal()">创建</button></div>
      </div>
      <p style="font-size:12px;color:#9ca3af;margin-bottom:8px">启用/禁用后点击「重连以刷新 Skills」即可让云端更新，无需重启桌面端</p>
      <div id="skillsList">加载中...</div>
    </div>
  </div>

  <div class="panel" id="panel-env">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2>运行环境</h2>
        <button class="btn btn-primary btn-sm" onclick="loadEnvCheck()">刷新</button>
      </div>
      <p style="font-size:14px;color:#9ca3af;margin-bottom:12px">以下为桌面端与 Skills 所需的运行环境。未安装时请按提示自行安装；仅「Playwright Chromium」支持一键安装。</p>
      <div id="envCheckList">加载中...</div>
      <div style="margin-top:10px" id="envInstallRow">
        <button class="btn btn-primary btn-sm" id="envInstallBtn" onclick="doEnvInstall()">安装缺失依赖</button>
        <span id="envInstallMsg" style="margin-left:10px;font-size:14px;color:#9ca3af"></span>
      </div>
    </div>
  </div>

</div>

<!-- Install Modal -->
<div class="modal-overlay" id="installModal">
  <div class="modal">
    <h3>从市场安装 Skill</h3>
    <p style="font-size:14px;color:#9ca3af;margin-bottom:10px">支持以下市场，将 Skill 页面或仓库 URL 粘贴到下方安装：</p>
    <ul style="font-size:14px;color:#9ca3af;margin-bottom:14px;padding-left:20px;line-height:1.6">
      <li><a href="https://skills.sh" target="_blank" rel="noopener" style="color:#60a5fa">https://skills.sh</a></li>
      <li><a href="https://clawhub.ai" target="_blank" rel="noopener" style="color:#60a5fa">https://clawhub.ai</a></li>
      <li><a href="https://skillsmp.com" target="_blank" rel="noopener" style="color:#60a5fa">https://skillsmp.com</a></li>
      <li>GitHub：<code style="font-size:.75rem">https://github.com/owner/repo</code> 或具体 SKILL.md 的 raw 链接</li>
    </ul>
    <div class="form-group"><label>URL</label><input id="installUrl" placeholder="https://skills.sh/owner/repo/skill"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="hideModal('installModal')">取消</button><button class="btn btn-primary btn-sm" onclick="doInstall()">安装</button></div>
  </div>
</div>

<!-- Add MCP Modal -->
<div class="modal-overlay" id="mcpCreateModal">
  <div class="modal" style="max-width:520px">
    <h3>新增 MCP 服务</h3>
    <p style="font-size:14px;color:#9ca3af;margin-bottom:14px">名称、命令与参数（第一项为可执行命令，其余为参数，每行一项）、环境变量可选</p>
    <div class="form-group"><label>名称</label><input id="mcpName" placeholder="filesystem"></div>
    <div class="form-group">
      <label>命令与参数（数组）</label>
      <div id="mcpCommandArgsList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
      <button type="button" class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="addMCPArgvRow()">+ 添加一项</button>
    </div>
    <div class="form-group">
      <label>环境变量</label>
      <div id="mcpEnvList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
      <button type="button" class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="addMCPEnvRow()">+ 添加环境变量</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="hideModal('mcpCreateModal')">取消</button><button class="btn btn-primary btn-sm" onclick="doCreateMCP()">添加</button></div>
  </div>
</div>

<!-- Create Skill Modal -->
<div class="modal-overlay" id="createModal">
  <div class="modal">
    <h3>创建自定义 Skill</h3>
    <div class="form-group"><label>名称</label><input id="createName" placeholder="my-skill"></div>
    <div class="form-group"><label>内容 (SKILL.md)</label><textarea id="createContent" style="min-height:150px" placeholder="---\nname: my-skill\ndescription: ...\n---\n\n# My Skill\n..."></textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="hideModal('createModal')">取消</button><button class="btn btn-primary btn-sm" onclick="doCreate()">创建</button></div>
  </div>
</div>

<!-- Skill Detail Modal -->
<div class="modal-overlay" id="skillDetailModal">
  <div class="modal" style="max-width:640px;width:95%">
    <h3 id="skillDetailTitle">Skill 详情</h3>
    <pre id="skillDetailContent" style="max-height:70vh;overflow:auto;font-size:14px;line-height:1.5;white-space:pre-wrap;background:#1a1d24;padding:14px;border-radius:8px;border:1px solid #333842;margin:0"></pre>
    <div style="margin-top:12px;display:flex;justify-content:flex-end"><button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="hideModal('skillDetailModal')">关闭</button></div>
  </div>
</div>

<!-- Env Hint Modal -->
<div class="modal-overlay" id="envHintModal">
  <div class="modal" style="max-width:520px;width:95%">
    <h3 id="envHintModalTitle">安装说明</h3>
    <div id="envHintModalContent" style="font-size:14px;color:#9ca3af;line-height:1.6;word-break:break-word;max-height:60vh;overflow:auto;white-space:pre-line"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end"><button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="hideModal('envHintModal')">关闭</button></div>
  </div>
</div>

<script>
const API='';
const SHOW_CONNECTION_FORM=${showConnectionForm ? "true" : "false"};
async function loadConnectionForm(){
  if(!SHOW_CONNECTION_FORM)return;
  try{const c=await fetch(API+'/api/connection').then(r=>r.json());
  document.getElementById('connWsUrl').value=c.ailoWsUrl||'';
  document.getElementById('connApiKey').value=c.ailoApiKey||'';
  document.getElementById('connEndpointId').value=c.endpointId||'';
  document.getElementById('connDisplayName').value=c.displayName||'';
  }catch(e){}
}
async function saveConnection(){
  const msg=document.getElementById('connectionSaveMsg');
  const ailoWsUrl=document.getElementById('connWsUrl').value.trim();
  const ailoApiKey=document.getElementById('connApiKey').value.trim();
  const endpointId=document.getElementById('connEndpointId').value.trim();
  const displayName=document.getElementById('connDisplayName').value.trim();
  if(!ailoWsUrl||!ailoApiKey||!endpointId){msg.textContent='请填写 AILO_WS_URL、AILO_API_KEY、AILO_ENDPOINT_ID';msg.style.color='#f87171';return;}
  try{const r=await fetch(API+'/api/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ailoWsUrl,ailoApiKey,endpointId,displayName})}).then(r=>r.json());
  if(r.ok){msg.textContent=r.message||'已保存';msg.style.color='#4ade80';}else{msg.textContent=r.error||'保存失败';msg.style.color='#f87171';}
  }catch(e){msg.textContent='请求失败';msg.style.color='#f87171';}
}
function showTab(name){document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',t.textContent.trim()==={chat:'网页聊天',status:'状态',tools:'工具',mcp:'MCP',skills:'Skills',env:'运行环境'}[name]));document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.getElementById('panel-'+name).classList.add('active');if(name==='env')loadEnvCheck();if(name==='skills')loadSkills();if(name==='mcp')loadMCP();if(name==='tools')showToolsSubTab('reported');}
function showToolsSubTab(sub){
  document.querySelectorAll('.tools-sub-btn').forEach(b=>b.classList.toggle('active',b.dataset.toolsSub===sub));
  document.querySelectorAll('.tools-sub-panel').forEach(p=>p.classList.toggle('active',p.dataset.toolsSub===sub));
  if(sub==='reported')loadReportedTools();if(sub==='blueprint')loadBlueprint();
}
function showInstallModal(){document.getElementById('installModal').style.display='flex';}
function showCreateModal(){document.getElementById('createModal').style.display='flex';}
function showMCPCreateModal(){
  const list=document.getElementById('mcpCommandArgsList');
  const envList=document.getElementById('mcpEnvList');
  list.innerHTML='';
  envList.innerHTML='';
  addMCPArgvRow('npx');
  addMCPArgvRow('-y');
  addMCPArgvRow('@modelcontextprotocol/server-filesystem');
  addMCPEnvRow('','');
  document.getElementById('mcpCreateModal').style.display='flex';
}
function addMCPArgvRow(val){
  const list=document.getElementById('mcpCommandArgsList');
  const n=list.querySelectorAll('.mcp-argv-row').length+1;
  const row=document.createElement('div');
  row.className='mcp-argv-row';
  row.style.display='flex';
  row.style.gap='8px';
  row.style.alignItems='center';
  row.innerHTML='<input type="text" class="mcp-argv-item input-sm" placeholder="'+(n===1?'命令（如 npx）':'参数')+'" style="flex:1;min-width:0"><button type="button" class="btn btn-sm" style="flex-shrink:0;padding:2px 8px" onclick="this.closest(\\'.mcp-argv-row\\').remove()">✕</button>';
  list.appendChild(row);
  row.querySelector('.mcp-argv-item').value=val||'';
}
function addMCPEnvRow(k,v){
  const list=document.getElementById('mcpEnvList');
  const row=document.createElement('div');
  row.className='mcp-env-row';
  row.style.display='flex';
  row.style.gap='8px';
  row.style.alignItems='center';
  row.innerHTML='<input type="text" class="mcp-env-key input-sm" placeholder="KEY" style="width:120px"><input type="text" class="mcp-env-val input-sm" placeholder="值" style="flex:1;min-width:0"><button type="button" class="btn btn-sm" style="flex-shrink:0;padding:2px 8px" onclick="this.closest(\\'.mcp-env-row\\').remove()">✕</button>';
  list.appendChild(row);
  row.querySelector('.mcp-env-key').value=k||'';
  row.querySelector('.mcp-env-val').value=v||'';
}
function hideModal(id){document.getElementById(id).style.display='none';}

function esc(s){if(s==null||s===undefined)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function formatEnvHint(s){
  if(!s)return '';
  const str=String(s).trim();
  const idx=str.indexOf('详见');
  if(idx>=0){ var url=str.slice(idx).replace(/^详见\\s*/,'').trim(); if(url&&/^https?:\\/\\//.test(url)) return esc(str.slice(0,idx))+' <span style="white-space:nowrap">详见 <a href="'+esc(url)+'" target="_blank" rel="noopener" style="color:#60a5fa">文档</a></span>'; }
  return esc(str);
}
function showEnvHintModal(btn){
  var titleEl=document.getElementById('envHintModalTitle');
  var contentEl=document.getElementById('envHintModalContent');
  if(titleEl)titleEl.textContent=(btn.getAttribute('data-name')||'')+' 安装说明';
  if(contentEl)contentEl.innerHTML=formatEnvHint(btn.getAttribute('data-hint')||'');
  document.getElementById('envHintModal').style.display='flex';
}
async function loadEnvCheck(){
  const el=document.getElementById('envCheckList');const row=document.getElementById('envInstallRow');if(!el)return;
  try{
    const d=await fetch(API+'/api/env/check').then(r=>r.json());
    const runtimes=d.runtimes||[];
    let h='<table class="env-table"><thead><tr><th>名称</th><th>功能</th><th>状态</th><th>安装说明</th></tr></thead><tbody>';
    let hasAutoInstallMissing=false;
    for(const r of runtimes){
      if(r.canAutoInstall&&!r.ok)hasAutoInstallMissing=true;
      h+='<tr><td>'+esc(r.name)+'</td><td style="color:#9ca3af;font-size:14px">'+esc(r.description)+'</td><td>';
      if(r.ok){h+='<span class="badge on">已安装</span>';if(r.detail)h+=' <span style="font-size:14px;color:#9ca3af">'+esc(r.detail)+'</span>';}
      else h+='<span class="badge off">未安装</span>';
      h+='</td><td>';
      if(!r.ok&&r.hint){h+='<button type="button" class="env-hint-toggle" data-name="'+esc(r.name)+'" data-hint="'+esc(r.hint)+'" onclick="showEnvHintModal(this)">安装教程</button>';}
      else h+='—';
      h+='</td></tr>';
    }
    h+='</tbody></table>';
    el.innerHTML=h||'<p style="color:#9ca3af;font-size:14px">暂无检测项</p>';
    if(row)row.style.display=hasAutoInstallMissing?'block':'none';
  }catch(e){el.textContent='加载失败';if(row)row.style.display='none';}
}
async function doEnvInstall(){
  const btn=document.getElementById('envInstallBtn');const msg=document.getElementById('envInstallMsg');
  if(btn)btn.disabled=true;if(msg){msg.textContent='正在安装…';msg.style.color='#94a3b8';}
  try{
    const r=await fetch(API+'/api/env/install',{method:'POST'}).then(x=>x.json());
    if(r.installed?.length){msg.textContent='已安装: '+r.installed.join(', ');msg.style.color='#4ade80';}
    if(r.errors?.length){msg.textContent=(msg.textContent||'')+' 失败: '+r.errors.join('; ');msg.style.color='#f87171';}
    loadEnvCheck();
  }catch(e){if(msg){msg.textContent='请求失败';msg.style.color='#f87171';}}
  if(btn)btn.disabled=false;
}
async function loadAll(){
  try{const s=await fetch(API+'/api/status').then(r=>r.json());
  document.getElementById('dot').className='dot '+(s.connected?'on':'off');
  document.getElementById('statusText').textContent=s.connected?'已连接':'未连接';
  document.getElementById('statusInfo').innerHTML='<div class="info-row"><span class="info-label">端点 ID</span><span class="info-value">'+(s.endpointId||'-')+'</span></div><div class="info-row"><span class="info-label">显示名</span><span class="info-value">'+(s.displayName||'-')+'</span></div><div class="info-row"><span class="info-label">状态</span><span class="info-value">'+(s.connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>')+'</span></div>';
  loadEnvCheck();
  }catch(e){document.getElementById('statusInfo').textContent='加载失败';}
}

async function loadMCP(){
  try{const d=await fetch(API+'/api/mcp').then(r=>r.json());const el=document.getElementById('mcpList');
  if(!d.servers||!d.servers.length){el.innerHTML='<p style="color:#9ca3af;font-size:14px">暂无 MCP 服务，点击「新增」添加</p>';return;}
  let h='<table><thead><tr><th>名称</th><th>命令</th><th>状态</th><th>工具</th><th>操作</th></tr></thead><tbody>';
  for(const s of d.servers){
    h+='<tr><td>'+s.name+'</td><td><code>'+(s.command||'')+' '+(s.args||[]).join(' ')+'</code></td><td>'+(s.running?'<span class="badge on">运行中</span>':'<span class="badge off">停止</span>')+'</td><td>'+(s.tools?.length||0)+'</td><td>';
    if(s.running)h+='<button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="mcpStop(\\''+s.name+'\\')">停止</button> ';
    else h+='<button class="btn btn-success btn-sm" onclick="mcpStart(\\''+s.name+'\\')">启动</button> ';
    h+='<button class="btn btn-danger btn-sm" onclick="mcpDelete(\\''+s.name+'\\')">删除</button></td></tr>';
  }
  el.innerHTML=h+'</tbody></table>';}catch(e){document.getElementById('mcpList').textContent='加载失败';}
}
async function doCreateMCP(){
  const name=document.getElementById('mcpName').value.trim();
  const argvItems=Array.from(document.querySelectorAll('.mcp-argv-item')).map(el=>el.value.trim()).filter(Boolean);
  const command=argvItems[0]||'';
  const args=argvItems.slice(1);
  const env={};
  document.querySelectorAll('.mcp-env-row').forEach(row=>{
    const k=(row.querySelector('.mcp-env-key').value||'').trim();
    if(k) env[k]=(row.querySelector('.mcp-env-val').value||'').trim();
  });
  if(!name||!command){alert('请填写名称和命令（命令与参数至少填第一项）');return;}
  try{const r=await fetch(API+'/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',name,command,args,env})}).then(r=>r.json());
  if(r.text){hideModal('mcpCreateModal');document.getElementById('mcpName').value='';loadMCP();alert(r.text);}
  else alert(r.error||'添加失败');}catch(e){alert('请求失败');}
}
async function mcpStart(name){try{const r=await fetch(API+'/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start',name})}).then(r=>r.json());loadMCP();if(r.text)alert(r.text);}catch(e){alert('请求失败');}}
async function mcpStop(name){try{await fetch(API+'/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'stop',name})});loadMCP();}catch(e){alert('请求失败');}}
async function mcpDelete(name){if(!confirm('确定删除 MCP 服务「'+name+'」？'))return;try{await fetch(API+'/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',name})});loadMCP();}catch(e){alert('请求失败');}}

async function loadSkills(){
  try{const d=await fetch(API+'/api/skills').then(r=>r.json());const el=document.getElementById('skillsList');
  if(!d.skills||!d.skills.length){el.innerHTML='<p style="color:#9ca3af;font-size:14px">暂无 Skills</p>';return;}
  let h='';for(const s of d.skills){
    h+='<div class="skill-card"><div><div style="display:flex;gap:8px;align-items:center"><strong>'+s.name+'</strong><span class="badge '+(s.source==='builtin'?'builtin':'custom')+'">'+s.source+'</span></div><div style="font-size:14px;color:#9ca3af;margin-top:4px">'+s.description+'</div></div><div style="display:flex;gap:8px;align-items:center">';
    h+='<button class="btn btn-sm" style="background:#374151;color:#e0e0e0" onclick="showSkillDetail(\\''+s.name.replace(/'/g,"\\'")+'\\')">详情</button>';
    h+='<label class="toggle"><input type="checkbox" '+(s.enabled?'checked':'')+' onchange="toggleSkill(\\''+s.name.replace(/'/g,"\\'")+'\\',this.checked)"><span class="slider"></span></label>';
    if(s.source==='customized')h+='<button class="btn btn-danger btn-sm" onclick="deleteSkill(\\''+s.name.replace(/'/g,"\\'")+'\\')">删除</button>';
    h+='</div></div>';}
  el.innerHTML=h;}catch(e){document.getElementById('skillsList').textContent='加载失败';}
}

async function showSkillDetail(name){
  const modal=document.getElementById('skillDetailModal');
  const titleEl=document.getElementById('skillDetailTitle');
  const contentEl=document.getElementById('skillDetailContent');
  titleEl.textContent=name+' — 详情';
  contentEl.textContent='加载中...';
  modal.style.display='flex';
  try{
    const r=await fetch(API+'/api/skills/'+encodeURIComponent(name)+'/content').then(r=>r.json());
    contentEl.textContent=(r.content!=null&&r.content!==''?r.content:'无内容');
  }catch(e){contentEl.textContent='加载失败';}
}
async function toggleSkill(name,enabled){
  await fetch(API+'/api/skills/'+encodeURIComponent(name)+'/'+(enabled?'enable':'disable'),{method:'POST'});loadSkills();}
async function deleteSkill(name){
  if(!confirm('确定删除 '+name+'？'))return;
  await fetch(API+'/api/skills/'+encodeURIComponent(name),{method:'DELETE'});loadSkills();}
async function doInstall(){
  const url=document.getElementById('installUrl').value;if(!url)return;
  try{const r=await fetch(API+'/api/skills/hub/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}).then(r=>r.json());
  alert('安装成功: '+r.name);hideModal('installModal');loadSkills();}catch(e){alert('安装失败: '+e.message);}}
async function doCreate(){
  const name=document.getElementById('createName').value;const content=document.getElementById('createContent').value;
  if(!name||!content)return;
  await fetch(API+'/api/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,content})});
  hideModal('createModal');loadSkills();}
async function doSkillsReconnect(){
  const btn=document.getElementById('skillsReconnectBtn');if(btn)btn.disabled=true;
  try{const r=await fetch(API+'/api/skills/reconnect',{method:'POST'}).then(x=>x.json());
  if(r.ok)alert(r.message||'已重连');else alert(r.error||'重连失败');}catch(e){alert('请求失败');}
  finally{if(btn)btn.disabled=false;}
}

async function loadReportedTools(){
  const el=document.getElementById('reportedToolsList');
  if(!el)return;
  try{
    const d=await fetch(API+'/api/tools').then(r=>r.json());
    if(!d||!d.length){el.innerHTML='<p style="color:#9ca3af;font-size:14px">暂无工具</p>';return;}
    let h='<table style="font-size:14px;width:100%"><thead><tr><th style="text-align:left;padding:10px 12px;border-bottom:1px solid #333842;color:#9ca3af;font-weight:500">工具</th><th style="text-align:left;padding:10px 12px;border-bottom:1px solid #333842;color:#9ca3af;font-weight:500">来源</th><th style="text-align:left;padding:10px 12px;border-bottom:1px solid #333842;color:#9ca3af;font-weight:500">说明</th></tr></thead><tbody>';
    for(const t of d){h+='<tr><td style="padding:10px 12px;border-bottom:1px solid #2d3139"><code>'+t.name+'</code></td><td style="padding:10px 12px;border-bottom:1px solid #2d3139"><span class="badge '+(t.source==='builtin'?'builtin':'custom')+'">'+t.source+'</span></td><td style="padding:10px 12px;border-bottom:1px solid #2d3139;color:#9ca3af">'+t.description+'</td></tr>';}
    el.innerHTML=h+'</tbody></table>';
  }catch(e){el.textContent='加载失败';}
}
async function loadBlueprint(){
  const urlEl=document.getElementById('blueprintUrlDisplay');
  const contentEl=document.getElementById('blueprintContent');
  if(!urlEl||!contentEl)return;
  contentEl.textContent='加载中...';
  try{
    const r=await fetch(API+'/api/blueprint').then(x=>x.json());
    urlEl.textContent=r.url||'未配置蓝图';
    contentEl.textContent=(r.content!=null&&r.content!=='')?r.content:'无内容或加载失败';
  }catch(e){contentEl.textContent='加载失败';}
}
loadConnectionForm();loadAll();setInterval(loadAll,15000);
</script>
</body>
</html>`;
}
