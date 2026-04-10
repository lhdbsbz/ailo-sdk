import { MCPConfigManager, startStdioServer, startSSEServer, stopSession, initializeSession, createStdioRpc, createSSERpc, handleSSEMessage } from "./mcp/index.js";
import type { MCPServerConfig, MCPSession, StdioSession, SSESession } from "./mcp/index.js";
import { ConsoleLogger, createComponentLogger, type ToolCapability } from "@greatlhd/ailo-endpoint-sdk";

const logger = createComponentLogger("mcp", new ConsoleLogger("[desktop]"));

type Args = Record<string, unknown>;

export class LocalMCPManager {
  private configManager = new MCPConfigManager();
  private sessions = new Map<string, MCPSession>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private onToolsChanged: (() => void) | null = null;

  setOnToolsChanged(cb: () => void): void {
    this.onToolsChanged = cb;
  }

  async init(): Promise<void> {
    await this.configManager.load();
    for (const [name, cfg] of this.configManager.getAll()) {
      if (cfg.enabled !== false) {
        await this.startServer(name, cfg).catch((e) => logger.error(`failed to start ${name}:`, { error: e.message }));
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
      case "tools": return { text: this.doTools(args), toolsChanged: false };
      case "create": return await this.doCreate(args);
      case "update": return await this.doUpdate(args);
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

  getConfigs(): Map<string, MCPServerConfig> {
    return this.configManager.getAll();
  }

  isRunning(name: string): boolean {
    return this.sessions.has(name);
  }

  getToolsForServer(name: string): ToolCapability[] {
    return this.sessions.get(name)?.tools ?? [];
  }

  private async checkConfigChange(): Promise<void> {
    const changed = await this.configManager.checkChanged();
    if (!changed) return;

    logger.info("config file changed, reloading...");
    await this.configManager.load();
    const newConfigs = this.configManager.getAll();
    let toolsChanged = false;

    for (const [name] of this.sessions) {
      if (!newConfigs.has(name) || newConfigs.get(name)?.enabled === false) {
        await this.stopServer(name);
        toolsChanged = true;
      }
    }

    for (const [name, cfg] of newConfigs) {
      if (cfg.enabled === false) continue;
      const existing = this.sessions.get(name);
      if (!existing) {
        await this.startServer(name, cfg).catch((e) =>
          logger.error(`reload failed for ${name}:`, { error: e.message }),
        );
        toolsChanged = true;
      }
    }

    if (toolsChanged) this.onToolsChanged?.();
  }

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
    const session = await startStdioServer(config, (code) => {
      logger.info(`${name} exited with code ${code}`);
      this.sessions.delete(name);
    });

    session.config = config;
    this.sessions.set(name, session);

    const { request, notify, processBuffer } = createStdioRpc(session);
    session.proc.stdout!.on("data", (chunk: Buffer) => {
      session.buffer += chunk.toString("utf-8");
      processBuffer();
    });

    await this.initMCPSession(name, session, request, notify);
  }

  private async startSSEServer(name: string, config: MCPServerConfig): Promise<void> {
    const session = await startSSEServer(config, (sess, data) => {
      handleSSEMessage(sess, data);
    }, () => {
      logger.info(`[sse] ${name} SSE stream ended`);
      this.sessions.delete(name);
    });

    session.config = config;
    this.sessions.set(name, session);
    logger.info(`[sse] ${name} connected, message endpoint: ${session.messageEndpoint}`);

    const { request, notify } = createSSERpc(session);
    await this.initMCPSession(name, session, request, notify);
  }

  private async initMCPSession(
    name: string,
    session: MCPSession,
    request: (method: string, params: unknown) => Promise<unknown>,
    notify: (method: string, params: unknown) => void,
  ): Promise<void> {
    try {
      const tools = await initializeSession(session, request, notify);
      session.tools = tools.map((t) => ({
        name: `${name}:${t.name}`,
        description: t.description,
        parameters: t.parameters,
      }));
      logger.info(`${name} started (${session.kind}), discovered ${session.tools.length} tool(s)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`${name} init failed:`, { error: msg });
      await this.stopServer(name);
      throw e;
    }
  }

  private async stopServer(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    this.sessions.delete(name);
    await stopSession(session);
  }

  async executeToolCall(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(serverName);
    if (!session) throw new Error(`MCP server not running: ${serverName}`);

    if (session.kind === "stdio") {
      const { request } = createStdioRpc(session);
      return request("tools/call", { name: toolName, arguments: args });
    } else {
      const { request } = createSSERpc(session);
      return request("tools/call", { name: toolName, arguments: args });
    }
  }

  private doTools(args: Args): string {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const session = this.sessions.get(name);
    if (!session) throw new Error(`MCP 服务未运行: ${name}`);
    const lines: string[] = [`MCP 服务「${name}」工具列表：`];
    for (const t of session.tools) {
      lines.push(`- ${t.name}`);
      lines.push(`  ${t.description ?? ""}`);
    }
    return lines.join("\n");
  }

  private doList(): string {
    const configs = this.configManager.getAll();
    if (configs.size === 0) return "没有已注册的 MCP 服务";
    const lines: string[] = ["MCP 服务列表："];
    for (const [name, cfg] of configs) {
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
      config = { transport: "sse", url, env: args.env as Record<string, string>, enabled: true };
    } else {
      const command = args.command as string;
      if (!command) throw new Error("command 必填");
      config = { transport: "stdio", command, args: args.args as string[], env: args.env as Record<string, string>, enabled: true };
    }
    this.configManager.set(name, config);
    await this.configManager.save();
    try {
      await this.startServer(name, config);
      const session = this.sessions.get(name);
      const toolCount = session?.tools.length ?? 0;
      return { text: `已创建并启动 MCP 服务 ${name}，发现 ${toolCount} 个工具`, toolsChanged: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `已创建 MCP 服务 ${name}，但启动失败: ${msg}`, toolsChanged: false };
    }
  }

  private async doUpdate(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const cfg = this.configManager.get(name);
    if (!cfg) throw new Error(`MCP 服务不存在: ${name}`);

    const transport = (args.transport as string) ?? cfg.transport ?? "stdio";
    let newConfig: MCPServerConfig;

    if (transport === "sse") {
      const url = args.url as string;
      if (!url) throw new Error("SSE 模式下 url 必填");
      newConfig = { transport: "sse", url, env: args.env as Record<string, string>, enabled: cfg.enabled !== false };
    } else {
      const command = args.command as string;
      if (!command) throw new Error("command 必填");
      newConfig = { transport: "stdio", command, args: args.args as string[], env: args.env as Record<string, string>, enabled: cfg.enabled !== false };
    }

    const wasRunning = this.sessions.has(name);
    if (wasRunning) {
      await this.stopServer(name);
    }

    this.configManager.set(name, newConfig);
    await this.configManager.save();

    if (wasRunning) {
      try {
        await this.startServer(name, newConfig);
        const session = this.sessions.get(name);
        const toolCount = session?.tools.length ?? 0;
        this.onToolsChanged?.();
        return { text: `已更新并重启 MCP 服务 ${name}，发现 ${toolCount} 个工具`, toolsChanged: true };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { text: `已更新 MCP 服务 ${name}，但重启失败: ${msg}`, toolsChanged: false };
      }
    } else {
      return { text: `已更新 MCP 服务 ${name}`, toolsChanged: false };
    }
  }

  private async doDelete(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const hadSession = this.sessions.has(name);
    if (hadSession) await this.stopServer(name);
    this.configManager.delete(name);
    await this.configManager.save();
    if (hadSession) this.onToolsChanged?.();
    return { text: `已删除 MCP 服务 ${name}`, toolsChanged: hadSession };
  }

  private async doStart(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const cfg = this.configManager.get(name);
    if (!cfg) throw new Error(`MCP 服务不存在: ${name}`);
    cfg.enabled = true;
    this.configManager.set(name, cfg);
    await this.configManager.save();
    await this.startServer(name, cfg);
    const session = this.sessions.get(name);
    const toolCount = session?.tools.length ?? 0;
    this.onToolsChanged?.();
    return { text: `已启动 MCP 服务 ${name}，发现 ${toolCount} 个工具`, toolsChanged: true };
  }

  private async doStop(args: Args): Promise<{ text: string; toolsChanged: boolean }> {
    const name = args.name as string;
    if (!name) throw new Error("name 必填");
    const cfg = this.configManager.get(name);
    if (!cfg) throw new Error(`MCP 服务不存在: ${name}`);
    cfg.enabled = false;
    this.configManager.set(name, cfg);
    await this.configManager.save();
    const hadSession = this.sessions.has(name);
    await this.stopServer(name);
    if (hadSession) this.onToolsChanged?.();
    return { text: `已停止 MCP 服务 ${name}`, toolsChanged: hadSession };
  }
}
