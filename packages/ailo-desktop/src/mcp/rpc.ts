import type { MCPSession, StdioSession, SSESession, PendingRPC } from "./session.js";
import { ConsoleLogger, createComponentLogger, type ToolCapability } from "@greatlhd/ailo-endpoint-sdk";

const logger = createComponentLogger("mcp", new ConsoleLogger("[desktop]"));

export async function initializeSession(
  session: MCPSession,
  request: (method: string, params: unknown) => Promise<unknown>,
  notify: (method: string, params: unknown) => void,
): Promise<ToolCapability[]> {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ailo-desktop", version: "1.0.0" },
  });

  notify("notifications/initialized", {});

  const result = await request("tools/list", {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
  const tools: ToolCapability[] = (result.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
  }));
  
  return tools;
}

export function createStdioRpc(
  session: StdioSession,
): {
  request: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
  processBuffer: () => void;
} {
  const request = (method: string, params: unknown): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const id = session.nextId++;
      session.pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      session.proc.stdin?.write(msg + "\n");
      setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  };

  const notify = (method: string, params: unknown): void => {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    session.proc.stdin?.write(msg + "\n");
  };

  const processBuffer = (): void => {
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
  };

  return { request, notify, processBuffer };
}

export function createSSERpc(
  session: SSESession,
): {
  request: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
} {
  const request = (method: string, params: unknown): Promise<unknown> => {
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
  };

  const notify = (method: string, params: unknown): void => {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    fetch(session.messageEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: msg,
      signal: session.abortController.signal,
    }).catch((err) => {
      logger.error("notify POST failed:", { error: err.message });
    });
  };

  return { request, notify };
}

export function handleSSEMessage(session: SSESession, data: string): void {
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
