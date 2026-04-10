import { actions } from "../store/index.js";
import { appStore } from "../store/index.js";
import type { LocalMCPManager } from "../mcp_manager.js";
import type { MCPServerConfig, MCPSession } from "./index.js";

export class MCPChannel {
  constructor(private mcpManager: LocalMCPManager) {
    this.mcpManager.setOnToolsChanged(() => {
      this.syncFromManager();
    });
    // 不在构造时 startWatching：须先 init() → load() 写入 lastMtime，
    // 否则首轮 checkChanged 会把「从未加载」误判为文件变更，在用户输入端口期间就拉起 MCP。
  }

  private syncFromManager(): void {
    const configs = this.mcpManager.getConfigs();
    for (const [name, config] of configs) {
      const isRunning = this.mcpManager.isRunning(name);
      const tools = this.mcpManager.getToolsForServer(name);
      actions.updateMCPServer(name, {
        name,
        status: isRunning ? "running" : "stopped",
        tools,
        config,
      });
    }
  }

  async init(): Promise<void> {
    await this.mcpManager.init();
    this.syncFromManager();
    this.mcpManager.startWatching();
  }

  async shutdown(): Promise<void> {
    this.mcpManager.stopWatching();
    await this.mcpManager.shutdown();
  }

  async handle(args: Record<string, unknown>): Promise<{ text: string; toolsChanged: boolean }> {
    const action = args.action as string;
    const name = args.name as string | undefined;

    if (action === "start" && name) {
      await this.startServer(name);
      return { text: `已启动 MCP 服务 ${name}`, toolsChanged: true };
    }

    if (action === "stop" && name) {
      await this.stopServer(name);
      return { text: `已停止 MCP 服务 ${name}`, toolsChanged: true };
    }

    if (action === "create") {
      const result = await this.mcpManager.handle(args);
      this.syncFromManager();
      return result;
    }

    if (action === "delete" && name) {
      const wasRunning = this.mcpManager.isRunning(name);
      const result = await this.mcpManager.handle(args);
      if (wasRunning) {
        actions.removeMCPServer(name);
      }
      return result;
    }

    if (action === "update") {
      const wasRunning = this.mcpManager.isRunning(name!);
      const result = await this.mcpManager.handle(args);
      if (wasRunning) {
        this.syncFromManager();
      }
      return result;
    }

    return this.mcpManager.handle(args);
  }

  async startServer(name: string): Promise<void> {
    const current = appStore.getState().mcp.servers.get(name);
    if (current) {
      actions.updateMCPServer(name, { ...current, status: "starting" });
    }

    try {
      await this.mcpManager.handle({ action: "start", name });
      this.syncFromManager();
    } catch (e) {
      if (current) {
        actions.updateMCPServer(name, { ...current, status: "error" });
      }
      throw e;
    }
  }

  async stopServer(name: string): Promise<void> {
    const current = appStore.getState().mcp.servers.get(name);
    if (current) {
      actions.updateMCPServer(name, { ...current, status: "stopping" });
    }

    await this.mcpManager.handle({ action: "stop", name });
    this.syncFromManager();
  }

  getAllPrivateTools(): ReturnType<LocalMCPManager["getAllPrivateTools"]> {
    return this.mcpManager.getAllPrivateTools();
  }

  isRunning(name: string): boolean {
    return this.mcpManager.isRunning(name);
  }

  executeToolCall(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.mcpManager.executeToolCall(serverName, toolName, args);
  }

  getConfigs(): Map<string, MCPServerConfig> {
    return this.mcpManager.getConfigs();
  }

  getManager(): LocalMCPManager {
    return this.mcpManager;
  }
}
