/**
 * bootstrap.ts — Helpers for launching endpoint processes.
 *
 * Feishu, webchat, email and similar "message-channel" endpoints are:
 *  1. Launched by Ailo (process manager injects AILO_WS_URL + AILO_API_KEY + AILO_ENDPOINT_ID).
 *  2. Connect to Ailo via the endpoint protocol using the injected API key.
 *  3. Optionally register tool handlers that respond to tool_request frames.
 *
 * Usage:
 *   runEndpoint({ handler, displayName, caps: ["message","tool_execute"] });
 */

import { EndpointClient } from "./endpoint-client.js";
import type { AcceptMessage, HealthStatus, ToolHandler, ToolCapability } from "./types.js";

export interface EndpointContext {
  /** Submit a message (or perception signal) to Ailo */
  accept(msg: AcceptMessage): Promise<void>;
  reportHealth(status: HealthStatus, detail?: string): void;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  sendSignal(signal: string, data?: unknown): void;
  onSignal(signal: string, callback: (data: unknown) => void): void;
  client: EndpointClient;
}

export interface EndpointHandler {
  start(ctx: EndpointContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface EndpointConfig {
  /** Display name shown in Ailo admin */
  displayName: string;
  /** Capability list (default: ["message","tool_execute"]) */
  caps?: string[];
  /** The endpoint handler (feishu, webchat, etc.) */
  handler: EndpointHandler;
  /** Tool declarations exposed to the agent at connect time */
  tools?: ToolCapability[];
  /** Map of tool name → handler function for automatic tool_request dispatch */
  toolHandlers?: Record<string, ToolHandler>;
  /** Blueprint IDs to activate for this endpoint session */
  blueprints?: string[];
  /** Override WebSocket URL (default: AILO_WS_URL env var) */
  ailoWsUrl?: string;
  /** Override API key (default: AILO_API_KEY env var) */
  ailoApiKey?: string;
  /** Override endpoint ID (default: AILO_ENDPOINT_ID env var) */
  endpointId?: string;
  /** Optional system instructions injected into agent context */
  instructions?: string;
}

export function runEndpoint(config: EndpointConfig): void {
  const { handler } = config;

  const ailoWsUrl = config.ailoWsUrl ?? process.env.AILO_WS_URL ?? "";
  const ailoApiKey = config.ailoApiKey ?? process.env.AILO_API_KEY ?? "";
  const endpointId = config.endpointId ?? process.env.AILO_ENDPOINT_ID ?? "";
  const caps = config.caps ?? ["message", "tool_execute"];

  if (!ailoWsUrl || !ailoApiKey || !endpointId) {
    console.error(
      "[endpoint] Missing AILO_WS_URL, AILO_API_KEY or AILO_ENDPOINT_ID. " +
      "Endpoint must be launched by Ailo or have these env vars configured.",
    );
    process.exit(1);
  }

  const tag = `[${endpointId}]`;

  const client = new EndpointClient({
    url: ailoWsUrl,
    apiKey: ailoApiKey,
    endpointId,
    displayName: config.displayName,
    caps,
    tools: config.tools,
    instructions: config.instructions,
    blueprints: config.blueprints,
  });

  if (config.toolHandlers) {
    const handlers = config.toolHandlers;
    client.onToolRequest(async (req) => {
      const fn = handlers[req.name];
      if (!fn) throw new Error(`unknown tool: ${req.name}`);
      return fn(req.args);
    });
  }

  const shutdown = () => {
    console.log(`${tag} shutting down...`);
    Promise.resolve(handler.stop()).catch(() => {});
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  (async () => {
    const ctx: EndpointContext = {
      accept: (msg) => client.accept(msg),
      reportHealth: (status, detail) => client.reportHealth(status, detail),
      log: (level, message, data) => client.sendLog(level, message, data),
      sendSignal: (signal, data) => client.sendSignal(signal, data),
      onSignal: (signal, callback) => {
        client.onSignal(signal, (_sig, data) => callback(data));
      },
      client,
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

/** @deprecated Use `EndpointConfig` instead. */
export type McpEndpointConfig = EndpointConfig;

/** @deprecated Use `runEndpoint` instead. */
export function runMcpEndpoint(config: EndpointConfig): void {
  return runEndpoint(config);
}
