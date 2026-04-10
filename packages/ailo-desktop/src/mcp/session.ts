import { spawn, type ChildProcess } from "child_process";
import { ConsoleLogger, createComponentLogger, type ToolCapability } from "@greatlhd/ailo-endpoint-sdk";

const sessionLogger = createComponentLogger("mcp", new ConsoleLogger("[desktop]"));

export interface PendingRPC {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface StdioSession {
  kind: "stdio";
  proc: ChildProcess;
  tools: ToolCapability[];
  buffer: string;
  nextId: number;
  pendingRequests: Map<number, PendingRPC>;
  config?: MCPServerConfig;
}

export interface SSESession {
  kind: "sse";
  tools: ToolCapability[];
  nextId: number;
  pendingRequests: Map<number, PendingRPC>;
  messageEndpoint: string;
  abortController: AbortController;
  config?: MCPServerConfig;
}

export type MCPSession = StdioSession | SSESession;

export interface MCPServerConfig {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

function shellEscape(arg: string): string {
  if (process.platform === "win32") {
    if (!/[ "&|<>^%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
  }
  if (!/[^a-zA-Z0-9_./:=@-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function startStdioServer(
  config: MCPServerConfig,
  onExit: (code: number | null) => void,
): Promise<StdioSession> {
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
    proc,
    tools: [],
    buffer: "",
    nextId: 1,
    pendingRequests: new Map(),
  };

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trim();
    if (text) sessionLogger.error(`[stderr] ${text}`);
  });

  proc.on("exit", (code) => {
    onExit(code);
    for (const [, pending] of session.pendingRequests) {
      pending.reject(new Error(`MCP process exited`));
    }
    session.pendingRequests.clear();
  });

  return session;
}

export async function startSSEServer(
  config: MCPServerConfig,
  onMessage: (session: SSESession, data: string) => void,
  onEnd: () => void,
): Promise<SSESession> {
  const baseUrl = config.url!.replace(/\/+$/, "");
  const sseUrl = `${baseUrl}/sse`;
  const abortController = new AbortController();

  const session: SSESession = {
    kind: "sse",
    tools: [],
    nextId: 1,
    pendingRequests: new Map(),
    messageEndpoint: "",
    abortController,
  };

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
          onEnd();
          for (const [, pending] of session.pendingRequests) {
            pending.reject(new Error(`SSE stream ended`));
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
            let ep = currentData;
            if (ep.startsWith("/")) ep = `${baseUrl}${ep}`;
            session.messageEndpoint = ep;
          } else if (currentEvent === "message") {
            onMessage(session, currentData);
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }
  };

  readLoop().catch((err) => {
    if (!abortController.signal.aborted) {
      sessionLogger.error(`[sse] read error: ${err.message}`);
      onEnd();
    }
  });

  return session;
}

export function stopSession(session: MCPSession): Promise<void> {
  if (session.kind === "stdio") {
    try { session.proc.kill("SIGTERM"); } catch {}
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { session.proc.kill("SIGKILL"); } catch {}
        resolve();
      }, 3000);
      session.proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  } else {
    session.abortController.abort();
    for (const [, pending] of session.pendingRequests) {
      pending.reject(new Error(`SSE session stopped`));
    }
    return Promise.resolve();
  }
}
