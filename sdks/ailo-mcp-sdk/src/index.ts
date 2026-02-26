import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * 启动 MCP Server（纯工具 / 单向发通道用）
 *
 * stdout 被 MCP stdio 占用，日志自动重定向到 stderr。
 */
export function runMcp(mcpServer: McpServer): void {
  const transport = new StdioServerTransport();
  mcpServer.connect(transport).then(() => {
    console.log("[mcp] MCP stdio server started");
  }).catch((err) => {
    console.error("[mcp] MCP start failed:", err);
    process.exit(1);
  });
}

/**
 * 返回 MCP 专属工作目录的绝对路径（AILO_MCP_WORKDIR）。
 * 无 workdir 时返回 null。
 */
export function getWorkDir(): string | null {
  const w = process.env.AILO_MCP_WORKDIR;
  return w || null;
}
