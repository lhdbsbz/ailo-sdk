import { spawn, type ChildProcess } from "child_process";
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join } from "path";
import { homedir, platform } from "os";
import type { ToolCapability } from "@lmcl/ailo-endpoint-sdk";

type Args = Record<string, unknown>;

interface MCPServerConfig {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

interface MCPConfigFile {
  mcpServers: Record<string, MCPServerConfig>;
}

interface PendingRPC {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface StdioSession {
  kind: "stdio";
  config: MCPServerConfig;
  proc: ChildProcess;
  tools: ToolCapability[];
  buffer: string;
  nextId: number;
  pendingRequests: Map<number, PendingRPC>;
}

interface SSESession {
  kind: "sse";
  config: MCPServerConfig;
  tools: ToolCapability[];
  nextId: number;
  pendingRequests: Map<number, PendingRPC>;
  messageEndpoint: string;
  abortController: AbortController;
}

type MCPSession = StdioSession | SSESession;

const CONFIG_DIR = join(homedir(), ".agents");
const CONFIG_PATH = join(CONFIG_DIR, "mcp_config.json");

export class LocalMCPManager {
  private sessions = new Map<string, MCPSession>();
  private configs = new Map<string, MCPServerConfig>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private lastMtime = 0;
  private onToolsChanged: (() => void) | null = null;

  setOnToolsChanged(cb: () => void): void {
    this.onToolsChanged = cb;
  }

  async init(): Promise<void> {
    await this.loadConfig();
    try {
      await stat(CONFIG_PATH);
    } catch {
      await this.saveConfig();
    }
    for (const [name, cfg] of this.configs) {
      if (cfg.enabled !== false) {
        await this.startServer(name, cfg).catch((e) => console.error(`[mcp] failed to start ${name}:`, e.message));
      }
    }
  }

  startWatching(intervalMs = 2000): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.checkConfigChange(), intervalMs);
  }

  stopWatching(): void {
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
  }

  async handle(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const action = args.action as string;
    switch (action) {
      case "list": return { text: this.doList(), toolsChanged: false };
      case "create": return await this.doCreate(args);
      case "delete": return await this.doDelete(args);
      case "start": return await this.doStart(args);
      case "stop": return await this.doStop(args);
      default: throw new Error(`未知 action: ${action}`);
    }
  }

  getAllPrivateTools(): ToolCapability[] {
    const all: ToolCapability[] = [];
    for (const session of this.sessions.values()) {
      all.push(...session.tools);
    }
    return all;
  }

  async shutdown(): Promise<void> {
    this.stopWatching();
    for (const [name] of this.sessions) {
      await this.stopServer(name);
    }
  }

  // --- Config persistence ---

  private async loadConfig(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const data = JSON.parse(raw) as MCPConfigFile;
      this.configs.clear();
      for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) {
        this.configs.set(name, cfg);
      }
      try {
        const s = await stat(CONFIG_PATH);
        this.lastMtime = s.mtimeMs;
      } catch {}
    } catch {
      // no config file yet
    }
  }

  private async saveConfig(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });
    const data: MCPConfigFile = { mcpServers: Object.fromEntries(this.configs) };
    await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
    try {
      const s = await stat(CONFIG_PATH);
      this.lastMtime = s.mtimeMs;
    } catch {}
  }

  private async checkConfigChange(): Promise<void> {
    try {
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(CONFIG_PATH);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      if (s.mtimeMs <= this.lastMtime) return;
      this.lastMtime = s.mtimeMs;
      console.log("[mcp] config file changed, reloading...");
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const data = JSON.parse(raw) as MCPConfigFile;
      const newConfigs = new Map(Object.entries(data.mcpServers ?? {}));
      let changed = false;
      for (const [name] of this.sessions) {
        if (!newConfigs.has(name) || newConfigs.get(name)?.enabled === false) {
          await this.stopServer(name);
          changed = true;
        }
      }
      for (const [name, cfg] of newConfigs) {
        if (cfg.enabled === false) continue;
        const existing = this.configs.get(name);
        if (!this.sessions.has(name) || JSON.stringify(existing) !== JSON.stringify(cfg)) {
          if (this.sessions.has(name)) await this.stopServer(name);
          await this.startServer(name, cfg).catch((e) =>
            console.error(`[mcp] reload failed for ${name}:`, e.message),
          );
          changed = true;
        }
      }
      this.configs = newConfigs;
      if (changed) this.onToolsChanged?.();
    } catch (e: any) {
      console.error("[mcp] config watch error:", e.message);
    }
  }

  // --- Server lifecycle ---

  private async startServer(name: string, config: MCPServerConfig): Promise<void> {
    if (this.sessions.has(name)) await this.stopServer(name);

    const transport = config.transport ?? "stdio";
    if (transport === "sse") {
      await this.startSSEServer(name, config);
    } else {
      await this.startStdioServer(name, config);
    }
  }

  private async startStdioServer(name: string, config: MCPServerConfig): Promise<void> {
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...(config.env ?? {}) };
    const args = config.args ?? [];
    const shellCmd = [config.command!, ...args].map(shellEscape).join(" ");
    const proc = spawn(shellCmd, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: true,
    });

    const session: StdioSession = {
      kind: "stdio",
      config,
      proc,
      tools: [],
      buffer: "",
      nextId: 1,
      pendingRequests: new Map(),
    };

    proc.stdout!.on("data", (chunk: Buffer) => {
      session.buffer += chunk.toString("utf-8");
      this.processStdioBuffer(session);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) console.error(`[mcp:${name}:stderr]`, text);
    });

    proc.on("exit", (code) => {
      console.log(`[mcp] ${name} exited with code ${code}`);
      this.sessions.delete(name);
      for (const [, pending] of session.pendingRequests) {
        pending.reject(new Error(`MCP process ${name} exited`));
      }
    });

    this.sessions.set(name, session);
    await this.initMCPSession(name, session);
  }

  private async startSSEServer(name: string, config: MCPServerConfig): Promise<void> {
    const baseUrl = config.url!.replace(/\/+$/, "");
    const sseUrl = `${baseUrl}/sse`;
    const abortController = new AbortController();

    const session: SSESession = {
      kind: "sse",
      config,
      tools: [],
      nextId: 1,
      pendingRequests: new Map(),
      messageEndpoint: "",
      abortController,
    };

    this.sessions.set(name, session);

    const messageEndpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("SSE connection timeout: no endpoint event received"));
      }, 15000);

      (async () => {
        try {
          const response = await fetch(sseUrl, {
            signal: abortController.signal,
            headers: { Accept: "text/event-stream" },
          });
          if (!response.ok) throw new Error(`SSE connect failed: HTTP ${response.status}`);
          if (!response.body) throw new Error("SSE response has no body");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let sseBuffer = "";
          let endpointResolved = false;

          const readLoop = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (!abortController.signal.aborted) {
                  console.log(`[mcp:sse] ${name} SSE stream ended`);
                  this.sessions.delete(name);
                  for (const [, pending] of session.pendingRequests) {
                    pending.reject(new Error(`SSE stream for ${name} ended`));
                  }
                }
                break;
              }
              sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split("\n");
              sseBuffer = lines.pop() ?? "";
              let currentEvent = "";
              let currentData = "";
              for (const line of lines) {
                if (line.startsWith("event:")) {
                  currentEvent = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                  currentData = line.slice(5).trim();
                } else if (line.trim() === "" && currentEvent) {
                  if (currentEvent === "endpoint" && !endpointResolved) {
                    endpointResolved = true;
                    clearTimeout(timeout);
                    let ep = currentData;
                    if (ep.startsWith("/")) ep = `${baseUrl}${ep}`;
                    resolve(ep);
                  } else if (currentEvent === "message") {
                    this.handleSSEMessage(session, currentData);
                  }
                  currentEvent = "";
                  currentData = "";
                }
              }
            }
          };
          readLoop().catch((err) => {
            if (!abortController.signal.aborted) {
              console.error(`[mcp:sse] ${name} read error:`, err.message);
              this.sessions.delete(name);
            }
          });
        } catch (err: any) {
          clearTimeout(timeout);
          reject(err);
        }
      })();
    });

    session.messageEndpoint = messageEndpoint;
    console.log(`[mcp:sse] ${name} connected, message endpoint: ${messageEndpoint}`);
    await this.initMCPSession(name, session);
  }

  private async initMCPSession(name: string, session: MCPSession): Promise<void> {
    try {
      await this.rpcRequest(session, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ailo-desktop", version: "1.0.0" },
      });

      this.rpcNotify(session, "notifications/initialized", {});

      const result = await this.rpcRequest(session, "tools/list", {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
      const tools: ToolCapability[] = (result.tools ?? []).map((t) => ({
        name: `${name}:${t.name}`,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      }));
      session.tools = tools;
      console.log(`[mcp] ${name} started (${session.kind}), discovered ${tools.length} tool(s)`);
    } catch (e: any) {
      console.error(`[mcp] ${name} init failed:`, e.message);
      await this.stopServer(name);
      throw e;
    }
  }

  private async stopServer(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    this.sessions.delete(name);

    if (session.kind === "stdio") {
      try { session.proc.kill("SIGTERM"); } catch {}
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { session.proc.kill("SIGKILL"); } catch {}
          resolve();
        }, 3000);
        session.proc.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    } else {
      session.abortController.abort();
      for (const [, pending] of session.pendingRequests) {
        pending.reject(new Error(`SSE session ${name} stopped`));
      }
    }
  }

  // --- JSON-RPC: unified dispatch ---

  private rpcRequest(session: MCPSession, method: string, params: unknown): Promise<unknown> {
    if (session.kind === "stdio") return this.stdioRpcRequest(session, method, params);
    return this.sseRpcRequest(session, method, params);
  }

  private rpcNotify(session: MCPSession, method: string, params: unknown): void {
    if (session.kind === "stdio") return this.stdioRpcNotify(session, method, params);
    this.sseRpcNotify(session, method, params);
  }

  // --- JSON-RPC over stdio ---

  private stdioRpcRequest(session: StdioSession, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = session.nextId++;
      session.pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      session.proc.stdin!.write(msg + "\n");
      setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private stdioRpcNotify(session: StdioSession, method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    session.proc.stdin!.write(msg + "\n");
  }

  private processStdioBuffer(session: StdioSession): void {
    const lines = session.buffer.split("\n");
    session.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && session.pendingRequests.has(msg.id)) {
          const pending = session.pendingRequests.get(msg.id)!;
          session.pendingRequests.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else pending.resolve(msg.result);
        }
      } catch {}
    }
  }

  // --- JSON-RPC over SSE ---

  private sseRpcRequest(session: SSESession, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = session.nextId++;
      session.pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      fetch(session.messageEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: msg,
        signal: session.abortController.signal,
      }).catch((err) => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id);
          reject(new Error(`SSE POST failed: ${err.message}`));
        }
      });
      setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private sseRpcNotify(session: SSESession, method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    fetch(session.messageEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: msg,
      signal: session.abortController.signal,
    }).catch((err) => {
      console.error(`[mcp:sse] notify POST failed:`, err.message);
    });
  }

  private handleSSEMessage(session: SSESession, data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.id !== undefined && session.pendingRequests.has(msg.id)) {
        const pending = session.pendingRequests.get(msg.id)!;
        session.pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    } catch {}
  }

  // --- Tool request execution ---

  async executeToolCall(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(serverName);
    if (!session) throw new Error(`MCP server not running: ${serverName}`);
    const result = await this.rpcRequest(session, "tools/call", { name: toolName, arguments: args });
    return result;
  }

  // --- Command handlers ---

  private doList(): string {
    if (this.configs.size === 0) return "没有已注册的 MCP 服务";
    const lines: string[] = ["MCP 服务列表："];
    for (const [name, cfg] of this.configs) {
      const session = this.sessions.get(name);
      const status = session ? "运行中" : (cfg.enabled !== false ? "已停止" : "已禁用");
      const transport = cfg.transport ?? "stdio";
      const toolCount = session?.tools.length ?? 0;
      lines.push(`- ${name}: ${status} | ${transport} | ${toolCount} 工具`);
      if (session && session.tools.length > 0) {
        for (const t of session.tools) {
          lines.push(`  - ${t.name}: ${t.description ?? ""}`);
        }
      }
    }
    return lines.join("\n");
  }

  private async doCreate(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const transport = (args.transport as string) ?? "stdio";
    let config: MCPServerConfig;
    if (transport === "sse") {
      const url = args.url as string;
      if (!url) throw new Error("SSE 模式下 url 必填");
      config = {
        transport: "sse",
        url,
        env: args.env as Record<string, string>,
        enabled: true,
      };
    } else {
      config = {
        transport: "stdio",
        command: args.command as string ?? "",
        args: args.args as string[],
        env: args.env as Record<string, string>,
        enabled: true,
      };
      if (!config.command) throw new Error("command 必填");
    }
    this.configs.set(name, config);
    await this.saveConfig();
    try {
      await this.startServer(name, config);
      const session = this.sessions.get(name);
      const toolCount = session?.tools.length ?? 0;
      return { text: `已创建并启动 MCP 服务 ${name}，发现 ${toolCount} 个工具`, toolsChanged: true };
    } catch (e: any) {
      return { text: `已创建 MCP 服务 ${name}，但启动失败: ${e.message}`, toolsChanged: false };
    }
  }

  private async doDelete(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const hadSession = this.sessions.has(name);
    if (hadSession) await this.stopServer(name);
    this.configs.delete(name);
    await this.saveConfig();
    return { text: `已删除 MCP 服务 ${name}`, toolsChanged: hadSession };
  }

  private async doStart(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`MCP 服务不存在: ${name}`);
    cfg.enabled = true;
    await this.saveConfig();
    await this.startServer(name, cfg);
    const session = this.sessions.get(name);
    const toolCount = session?.tools.length ?? 0;
    return { text: `已启动 MCP 服务 ${name}，发现 ${toolCount} 个工具`, toolsChanged: true };
  }

  private async doStop(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`MCP 服务不存在: ${name}`);
    cfg.enabled = false;
    await this.saveConfig();
    const hadSession = this.sessions.has(name);
    await this.stopServer(name);
    return { text: `已停止 MCP 服务 ${name}`, toolsChanged: hadSession };
  }

  // --- Query methods for config UI ---

  getConfigs(): Map<string, MCPServerConfig> { return this.configs; }
  isRunning(name: string): boolean { return this.sessions.has(name); }
  getToolsForServer(name: string): ToolCapability[] { return this.sessions.get(name)?.tools ?? []; }
}

function shellEscape(arg: string): string {
  if (platform() === "win32") {
    if (!/[ "&|<>^%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
  }
  if (!/[^a-zA-Z0-9_./:=@-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
