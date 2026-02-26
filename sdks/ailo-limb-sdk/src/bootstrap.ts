import { LimbClient } from "./limb-client.js";
import type { LimbHandler, LimbContext, Percept } from "./types.js";

export interface McpLimbConfig {
  channel?: string;
  displayName: string;
  handler: LimbHandler;
  ailoWsUrl?: string;
  ailoToken?: string;
  instructions?: string;
}

export function runMcpLimb(config: McpLimbConfig): void {
  const { handler } = config;
  const channel = config.channel ?? process.env.AILO_MCP_NAME ?? "";
  const ailoWsUrl = config.ailoWsUrl ?? process.env.AILO_WS_URL ?? "";
  const ailoToken = config.ailoToken ?? process.env.AILO_TOKEN ?? "";

  if (!ailoWsUrl || !ailoToken || !channel) {
    console.error("Missing AILO_WS_URL, AILO_TOKEN or AILO_MCP_NAME. Channel must be started by Ailo MCP.");
    process.exit(1);
  }

  const tag = `[${channel}]`;

  const client = new LimbClient({
    url: ailoWsUrl,
    token: ailoToken,
    channel,
    displayName: config.displayName,
    instructions: config.instructions,
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
    try {
      await client.connect();
      console.log(`${tag} Ailo WebSocket connected`);
    } catch (err) {
      console.error(`${tag} Ailo WebSocket connect failed:`, err);
      process.exit(1);
    }

    const ctx: LimbContext = {
      percept: (p: Percept) => client.percept(p),
      storage: client,
      log: (level, message, data) => client.sendLog(level, message, data),
      reportHealth: (status, detail) => client.reportHealth(status, detail),
    };

    try {
      await handler.start(ctx);
      console.log(`${tag} handler started`);
    } catch (err) {
      console.error(`${tag} handler start failed:`, err);
      process.exit(1);
    }
  })();
}
