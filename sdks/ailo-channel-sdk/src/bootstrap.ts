import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AiloClient } from "./ailo-client.js";
import type { ChannelHandler, ChannelMessage, ChannelContext } from "./types.js";

export interface McpChannelConfig {
  channelName?: string;
  displayName: string;
  defaultRequiresResponse?: boolean;
  handler: ChannelHandler;
  ailoWsUrl?: string;
  ailoToken?: string;
  buildChannelInstructions?: () => string;
  mcpServer: McpServer;
}

export function defaultChannelInstructions(): string {
  return `用户 @你 时会在消息中标注。`;
}

export function runMcpChannel(config: McpChannelConfig): void {
  const { handler, mcpServer } = config;
  const channelName = config.channelName ?? process.env.AILO_MCP_NAME ?? "";
  const ailoWsUrl = config.ailoWsUrl ?? process.env.AILO_WS_URL ?? "";
  const ailoToken = config.ailoToken ?? process.env.AILO_TOKEN ?? "";

  if (!ailoWsUrl || !ailoToken || !channelName) {
    console.error("Missing AILO_WS_URL, AILO_TOKEN or AILO_MCP_NAME. Channel must be started by Ailo MCP.");
    process.exit(1);
  }

  const tag = `[${channelName}]`;
  const channelInstructions = config.buildChannelInstructions?.() ?? defaultChannelInstructions();
  const defaultRequiresResponse = config.defaultRequiresResponse ?? true;

  const client = new AiloClient({
    url: ailoWsUrl,
    token: ailoToken,
    channel: channelName,
    displayName: config.displayName,
    defaultRequiresResponse,
    channelInstructions,
  });

  const shutdown = () => {
    console.log(`${tag} shutting down...`);
    Promise.resolve(handler.stop()).catch(() => {});
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  (async () => {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.log(`${tag} MCP stdio server started`);

    const ctx: ChannelContext = {
      accept: async (msg: ChannelMessage) => {
        const hasContent = (msg.content?.length ?? 0) > 0 || msg.contextTags.length > 0;
        if (!hasContent) return;
        await client.sendMessage(msg);
      },
      storage: client,
      log: (level, message, data) => client.sendLog(level, message, data),
      reportHealth: (status, detail) => client.reportHealth(status, detail),
      onSignal: (signal, callback) => client.onSignal(signal, callback),
      sendSignal: (signal, data) => client.sendSignal(signal, data),
    };

    try {
      await client.connect();
      console.log(`${tag} Ailo WebSocket connected`);
    } catch (err) {
      console.error(`${tag} Ailo WebSocket connect failed:`, err);
      process.exit(1);
    }

    try {
      await handler.start(ctx);
      console.log(`${tag} handler started`);
    } catch (err) {
      console.error(`${tag} handler start failed:`, err);
      process.exit(1);
    }
  })();
}
