import WebSocket from "ws";
import path from "path";
import type {
  AcceptMessage,
  ContentPart,
  WorldUpdatePayload,
  ToolResponsePayload,
  WorldEnrichmentPayload,
  IntentPayload,
  ToolRequestPayload,
  StreamPayload,
  ToolCapability,
  SkillMeta,
  HealthStatus,
  EndpointStorage,
} from "./types.js";

const SDK_VERSION = "1.0.0";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function resolveBlueprintPath(blueprint: string): string {
  if (!blueprint) return "";
  if (blueprint.startsWith("http://") || blueprint.startsWith("https://") || blueprint.startsWith("file://")) {
    return blueprint;
  }
  const cwd = process.cwd();
  return path.resolve(cwd, blueprint);
}
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const OFFLINE_BUFFER_MAX = 200;

/** 配置变更后重连前的冷却时间（秒级），避免抖动 */
export const RECONNECT_COOLDOWN_MS = 1000;

// ─── Internal frame types ─────────────────────────────────────────────────────

type Frame = {
  type: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
  event?: string;
  seq?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ─── Callback types ───────────────────────────────────────────────────────────

export type ToolRequestHandler = (payload: ToolRequestPayload) => Promise<unknown>;
export type IntentHandler = (payload: IntentPayload) => void;
export type WorldEnrichmentHandler = (payload: WorldEnrichmentPayload) => void;
export type StreamHandler = (payload: StreamPayload) => void;
export type SignalHandler = (signal: string, data: unknown) => void;
export type EvictedHandler = () => void;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface EndpointClientConfig {
  /** WSS URL of the Ailo server, e.g. "wss://your-server.com/ws" */
  url: string;
  /** Pre-created API key from the aido admin UI */
  apiKey: string;
  /** Unique identifier for this endpoint, e.g. "robot-01" */
  endpointId: string;
  /** Human-readable display name */
  displayName: string;
  /** Capability list — determines which messages this endpoint sends/receives */
  caps: string[];
  /**
   * Tools this endpoint can execute.
   * Declared at connect so the agent knows which tool_request names to route here.
   * Only relevant when "tool_execute" is in caps.
   */
  tools?: ToolCapability[];
  /** Optional system-level instructions injected into agent context */
  instructions?: string;
  /** Blueprint IDs to activate for this endpoint session */
  blueprints?: string[];
  /** Skills loaded from local SKILL.md files, reported to the brain at connect time */
  skills?: SkillMeta[];
  /** Max messages to buffer while disconnected (default: 200, 0 = disabled) */
  offlineBufferSize?: number;
}

/** 仅连接相关字段，用于热更新配置后重连（reconnect 第二参数） */
export type ConnectionOverrides = Partial<
  Pick<EndpointClientConfig, "url" | "apiKey" | "endpointId" | "displayName">
>;

// ─── EndpointClient ───────────────────────────────────────────────────────────

/**
 * EndpointClient connects any external endpoint (robot, feishu, camera, IoT, …)
 * to Ailo using the unified Endpoint protocol with API-key authentication.
 *
 * Usage:
 *   const client = new EndpointClient({ url, apiKey, endpointId, caps: ["world_update","tool_execute","intent"] });
 *   client.onToolRequest(async (req) => { ... return result; });
 *   client.onIntent((intent) => { ... });
 *   await client.connect();
 *   await client.worldUpdate({ mode: "aware", obstacles: [100,200,150] });
 */
export class EndpointClient implements EndpointStorage {
  private ws: WebSocket | null = null;
  private cfg: EndpointClientConfig;
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private offlineBuffer: AcceptMessage[] = [];
  private readonly offlineBufferMax: number;

  private toolRequestHandler: ToolRequestHandler | null = null;
  private intentHandler: IntentHandler | null = null;
  private worldEnrichmentHandler: WorldEnrichmentHandler | null = null;
  private streamHandler: StreamHandler | null = null;
  private signalHandlers = new Map<string, SignalHandler[]>();
  private evictedHandler: EvictedHandler | null = null;

  constructor(config: EndpointClientConfig) {
    this.cfg = config;
    this.offlineBufferMax = config.offlineBufferSize ?? OFFLINE_BUFFER_MAX;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.intentionalClose = false;
    await this.dial();
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    this.rejectAllPending(new Error("client closed"));
    this.offlineBuffer.length = 0;
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  /**
   * Reconnect with optional updated skills and/or connection config.
   * - skills: so the server gets the latest enabled skills without restarting.
   * - connectionOverrides: url/apiKey/endpointId/displayName — disconnect, wait ~1s, then connect with new config.
   */
  async reconnect(skills?: SkillMeta[], connectionOverrides?: ConnectionOverrides): Promise<void> {
    if (skills !== undefined) this.cfg = { ...this.cfg, skills };
    if (connectionOverrides) {
      const { url, apiKey, endpointId, displayName } = connectionOverrides;
      if (url !== undefined) this.cfg = { ...this.cfg, url };
      if (apiKey !== undefined) this.cfg = { ...this.cfg, apiKey };
      if (endpointId !== undefined) this.cfg = { ...this.cfg, endpointId };
      if (displayName !== undefined) this.cfg = { ...this.cfg, displayName };
    }
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.rejectAllPending(new Error("reconnecting"));
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    if (connectionOverrides) {
      await new Promise((r) => setTimeout(r, RECONNECT_COOLDOWN_MS));
    }
    await this.connect();
  }

  // ─── Callback registration ──────────────────────────────────────────────────

  /** Register a handler for incoming tool_request frames. The return value becomes tool_response.result. */
  onToolRequest(handler: ToolRequestHandler): this {
    this.toolRequestHandler = handler;
    return this;
  }

  /** Register a handler for incoming intent frames. */
  onIntent(handler: IntentHandler): this {
    this.intentHandler = handler;
    return this;
  }

  /** Register a handler for incoming world_enrichment frames. */
  onWorldEnrichment(handler: WorldEnrichmentHandler): this {
    this.worldEnrichmentHandler = handler;
    return this;
  }

  /**
   * Register a handler for streamed text chunks from the agent.
   * Called three times per stream: action="start", then one or more "chunk", then "end".
   */
  onStream(handler: StreamHandler): this {
    this.streamHandler = handler;
    return this;
  }

  /** Register a handler for incoming signal frames. */
  onSignal(signal: string, handler: SignalHandler): this {
    const list = this.signalHandlers.get(signal) ?? [];
    list.push(handler);
    this.signalHandlers.set(signal, list);
    return this;
  }

  /**
   * Register a handler called when this endpoint is evicted by a newer instance
   * connecting with the same endpointId. The process should exit in this handler.
   */
  onEvicted(handler: EvictedHandler): this {
    this.evictedHandler = handler;
    return this;
  }

  // ─── Outbound methods ────────────────────────────────────────────────────────

  /**
   * Send a conversational message (requires caps: ["message"]).
   * This calls the endpoint.accept method on the server.
   */
  async accept(msg: AcceptMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.intentionalClose || this.offlineBufferMax <= 0) throw new Error("not connected");
      if (this.offlineBuffer.length >= this.offlineBufferMax)
        throw new Error(`offline buffer full (${this.offlineBufferMax})`);
      this.offlineBuffer.push(msg);
      return;
    }
    await this.acceptDirect(msg);
  }

  /**
   * Send a world_update frame (requires caps: ["world_update"]).
   * Carries sensor/perception data to the agent for scene understanding.
   */
  async worldUpdate(payload: WorldUpdatePayload): Promise<void> {
    await this.request("world_update", payload as unknown as Record<string, unknown>);
  }

  /**
   * Send a tool_response frame (requires caps: ["tool_execute"]).
   * Call this after receiving and executing a tool_request.
   */
  async toolResponse(payload: ToolResponsePayload): Promise<void> {
    await this.request("tool_response", payload as unknown as Record<string, unknown>);
  }

  /** Report the platform/hardware health status. */
  reportHealth(status: HealthStatus, detail?: string): void {
    const params: Record<string, unknown> = { status };
    if (detail) params.detail = detail;
    this.request("endpoint.health", params).catch(() => {});
  }

  /** Send a log entry to the server (when local stdout is occupied). */
  sendLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const params: Record<string, unknown> = { level, message };
    if (data && Object.keys(data).length > 0) params.data = data;
    this.request("endpoint.log", params).catch(() => {});
  }

  /** Send a signal frame. */
  sendSignal(signal: string, data?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "signal", id: signal, payload: data }));
  }

  // ─── EndpointStorage ──────────────────────────────────────────────────────

  async getData(key: string): Promise<string | null> {
    const res = await this.request<{ found: boolean; value?: string }>(
      "endpoint.data.get", { key },
    );
    return res.found ? (res.value ?? null) : null;
  }

  async setData(key: string, value: string): Promise<void> {
    await this.request("endpoint.data.set", { key, value });
  }

  async deleteData(key: string): Promise<void> {
    await this.request("endpoint.data.delete", { key });
  }

  // ─── Internal: dial + handshake ─────────────────────────────────────────────

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.url);
      let settled = false;
      const settle = (ok: boolean, err?: unknown) => {
        if (settled) return;
        settled = true;
        ok ? resolve() : reject(err);
      };

      ws.on("open", async () => {
        try {
          await this.handshake(ws);
          this.ws = ws;
          this.reconnectAttempt = 0;
          this.attachHandlers(ws);
          this.startHeartbeat();
          this.flushOfflineBuffer();
          settle(true);
        } catch (err) {
          ws.close();
          settle(false, err);
        }
      });

      ws.on("error", (err) => settle(false, err));
      ws.on("close", () => settle(false, new Error("closed before handshake")));
    });
  }

  private handshake(ws: WebSocket): Promise<void> {
    const id = `connect-${++this.reqId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", handler);
        reject(new Error("handshake timeout"));
      }, REQUEST_TIMEOUT_MS);

      const handler = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString()) as Frame;
        if (frame.type === "res" && frame.id === id) {
          clearTimeout(timer);
          ws.off("message", handler);
          frame.ok
            ? resolve()
            : reject(new Error(frame.error?.message ?? "connect rejected"));
        }
      };
      ws.on("message", handler);
      const connectParams: Record<string, unknown> = {
        role: "endpoint",
        apiKey: this.cfg.apiKey,
        endpointId: this.cfg.endpointId,
        displayName: this.cfg.displayName,
        caps: this.cfg.caps,
        sdkVersion: SDK_VERSION,
      };
      if (this.cfg.instructions) connectParams.instructions = this.cfg.instructions;
      if (this.cfg.tools && this.cfg.tools.length > 0) connectParams.tools = this.cfg.tools;
      if (this.cfg.blueprints && this.cfg.blueprints.length > 0) {
        connectParams.blueprints = this.cfg.blueprints.map(resolveBlueprintPath);
      }
      if (this.cfg.skills && this.cfg.skills.length > 0) connectParams.skills = this.cfg.skills;
      ws.send(JSON.stringify({ type: "req", id, method: "connect", params: connectParams }));
    });
  }

  // ─── Internal: message handling ──────────────────────────────────────────────

  private attachHandlers(ws: WebSocket): void {
    ws.on("message", (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Frame;

      // res: correlate with pending requests
      if (frame.type === "res" && frame.id) {
        const req = this.pending.get(frame.id);
        if (!req) return;
        this.pending.delete(frame.id);
        clearTimeout(req.timer);
        frame.ok
          ? req.resolve(frame.payload ?? {})
          : req.reject(new Error(frame.error?.message ?? "request failed"));
        return;
      }

      // event: server-pushed frames
      if (frame.type === "event") {
        this.handleEvent(frame);
        return;
      }

      // signal: bidirectional control messages
      if (frame.type === "signal" && frame.id) {
        const handlers = this.signalHandlers.get(frame.id);
        if (handlers) {
          for (const h of handlers) h(frame.id, frame.payload);
        }
        return;
      }
    });

    ws.on("close", (code, reason) => {
      const isEvicted =
        code === 1001 && reason?.toString().includes("replaced");

      if (isEvicted) {
        // 被新实例顶掉，当前进程没有继续运行的意义，通知上层退出。
        this.intentionalClose = true;
        this.evictedHandler?.();
        return;
      }

      // 如果触发 close 的不是当前活跃连接（极端竞态），直接忽略。
      if (ws !== this.ws) return;

      this.onDisconnect();
    });
    ws.on("pong", () => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    });
  }

  private handleEvent(frame: Frame): void {
    switch (frame.event) {
      case "tool_request": {
        const payload = frame.payload as ToolRequestPayload;
        if (!this.toolRequestHandler || !payload?.id) return;
        void this.toolRequestHandler(payload)
          .then((result) => {
            if (Array.isArray(result) && result.length > 0 && typeof result[0] === "object" && result[0] !== null && "type" in result[0]) {
              return this.toolResponse({ id: payload.id, success: true, content: result as ContentPart[] });
            }
            return this.toolResponse({ id: payload.id, success: true, result });
          })
          .catch((err: Error) =>
            this.toolResponse({ id: payload.id, success: false, error: err.message }),
          );
        break;
      }
      case "intent": {
        const payload = frame.payload as IntentPayload;
        this.intentHandler?.(payload);
        break;
      }
      case "world_enrichment": {
        const payload = frame.payload as WorldEnrichmentPayload;
        this.worldEnrichmentHandler?.(payload);
        break;
      }
      case "stream": {
        const payload = frame.payload as StreamPayload;
        this.streamHandler?.(payload);
        break;
      }
      default:
        break;
    }
  }

  // ─── Internal: request / heartbeat / reconnect ───────────────────────────────

  private request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = `${method}-${++this.reqId}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private async acceptDirect(msg: AcceptMessage): Promise<void> {
    const params: Record<string, unknown> = {
      content: msg.content,
      contextTags: msg.contextTags,
    };
    if (msg.requiresResponse !== undefined) params.requiresResponse = msg.requiresResponse;
    await this.request("endpoint.accept", params);
  }

  private flushOfflineBuffer(): void {
    if (this.offlineBuffer.length === 0) return;
    const buffered = this.offlineBuffer.splice(0);
    for (const msg of buffered) {
      this.acceptDirect(msg).catch((err) =>
        console.error(`[endpoint-client] replay failed: ${(err as Error).message}`),
      );
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        console.error("[endpoint-client] pong timeout, closing");
        this.ws?.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private onDisconnect(): void {
    this.ws = null;
    this.stopHeartbeat();
    this.rejectAllPending(new Error("disconnected"));
    if (!this.intentionalClose) this.scheduleReconnect();
  }

  private rejectAllPending(err: Error): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    console.error(`[endpoint-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial().catch((err) => {
        console.error(`[endpoint-client] reconnect failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }
}
