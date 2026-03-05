import WebSocket from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
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
  EndpointUpdateParams,
  FileFetchRequest,
  DirListRequest,
  FilePushRequest,
  FsProbeMarker,
  FsProbeRequest,
} from "./types.js";

const SDK_VERSION = "1.0.0";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function resolveBlueprintPath(blueprint: string): string {
  if (!blueprint) return "";
  if (blueprint.startsWith("http://") || blueprint.startsWith("https://") || blueprint.startsWith("file://")) {
    return blueprint;
  }
  if (!path.isAbsolute(blueprint)) {
    console.warn(
      `[endpoint] Blueprint path "${blueprint}" is relative — this may break if the working directory changes. ` +
      `Use an absolute path (e.g. via import.meta.url) instead.`,
    );
  }
  return path.resolve(blueprint);
}
const HANDSHAKE_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const OFFLINE_BUFFER_MAX = 200;

/** Cooldown before reconnecting after config change, to avoid thrashing */
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
  /** WebSocket URL of the Ailo server, e.g. "wss://your-server.com/ws" */
  url: string;
  /** Pre-created API key from the Ailo admin dashboard */
  apiKey: string;
  /** Unique identifier for this endpoint, e.g. "robot-01" */
  endpointId: string;
  /** Capability list — determines which messages this endpoint sends/receives */
  caps: string[];
  /**
   * Tools this endpoint can execute.
   * Declared at connect time so the server knows which tool_request names to route here.
   * Only relevant when "tool_execute" is in caps.
   */
  tools?: ToolCapability[];
  /** Optional instructions describing this endpoint's environment or constraints */
  instructions?: string;
  /** Blueprint IDs to activate for this endpoint session */
  blueprints?: string[];
  /** Skills loaded from local SKILL.md files, reported to the server at connect time */
  skills?: SkillMeta[];
  /** Max messages to buffer while disconnected (default: 200, 0 = disabled) */
  offlineBufferSize?: number;
}

/** Connection-only fields for hot-reloading config (passed as second arg to reconnect) */
export type ConnectionOverrides = Partial<
  Pick<EndpointClientConfig, "url" | "apiKey" | "endpointId">
>;

// ─── EndpointClient ───────────────────────────────────────────────────────────

/**
 * Connects any external endpoint (robot, Lark, camera, IoT, …) to an Ailo server
 * using the unified Endpoint Protocol with API-key authentication.
 *
 * @example
 * ```ts
 * const client = new EndpointClient({ url, apiKey, endpointId, caps: ["message", "tool_execute"] });
 * client.onToolRequest(async (req) => { ... return result; });
 * await client.connect();
 * await client.accept({ content: [{ type: "text", text: "Hello" }], contextTags: [] });
 * ```
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
  private fsProbeMarker: FsProbeMarker | null = null;
  private reconnectWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(config: EndpointClientConfig) {
    this.cfg = config;
    this.offlineBufferMax = config.offlineBufferSize ?? OFFLINE_BUFFER_MAX;
    this.fsProbeMarker = this.writeFsProbeFile();
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
    this.rejectReconnectWaiters(new Error("client closed"));
    this.offlineBuffer.length = 0;
    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.fsProbeMarker) {
      try { fs.unlinkSync(this.fsProbeMarker.path); } catch {}
      this.fsProbeMarker = null;
    }
  }

  /**
   * Reconnect with optional updated skills, tools, blueprints, and/or connection config.
   * - skills: so the server gets the latest enabled skills without restarting.
   * - tools: update the private tools set for the next connect handshake.
   * - blueprints: update the blueprint URLs for the next connect handshake.
   * - connectionOverrides: url/apiKey/endpointId — disconnect, wait ~1s, then connect with new config.
   */
  async reconnect(
    skills?: SkillMeta[],
    connectionOverrides?: ConnectionOverrides,
    tools?: ToolCapability[],
    blueprints?: string[],
  ): Promise<void> {
    if (skills !== undefined) this.cfg = { ...this.cfg, skills };
    if (tools !== undefined) this.cfg = { ...this.cfg, tools };
    if (blueprints !== undefined) this.cfg = { ...this.cfg, blueprints };
    if (connectionOverrides) {
      const { url, apiKey, endpointId } = connectionOverrides;
      if (url !== undefined) this.cfg = { ...this.cfg, url };
      if (apiKey !== undefined) this.cfg = { ...this.cfg, apiKey };
      if (endpointId !== undefined) this.cfg = { ...this.cfg, endpointId };
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

  /**
   * Incrementally update capabilities after connection — register new or unregister existing
   * tools, blueprints, skills, caps, or instructions without reconnecting.
   */
  async update(params: EndpointUpdateParams): Promise<void> {
    await this.request("endpoint.update", params);
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
   * Register a handler for streamed text output.
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

  /** Send a conversational message (requires cap: "message"). */
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

  /** Send a world_update frame (requires cap: "world_update"). Carries sensor/perception data. */
  async worldUpdate(payload: WorldUpdatePayload): Promise<void> {
    await this.request("world_update", payload as unknown as Record<string, unknown>);
  }

  /** Send a tool_response frame. Call this after receiving and executing a tool_request.
   *  If the connection is down but a reconnect is in progress, waits for reconnection before sending. */
  async toolResponse(payload: ToolResponsePayload): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this.intentionalClose) {
        await this.waitForConnection();
      }
    }
    await this.request("tool_response", payload as unknown as Record<string, unknown>);
  }

  /** Report the platform/hardware health status. */
  reportHealth(status: HealthStatus, detail?: string): void {
    const params: Record<string, unknown> = { status };
    if (detail) params.detail = detail;
    this.request("endpoint.health", params).catch(() => {});
  }

  /** Forward a log entry to the server (useful when local stdout is occupied by MCP stdio). */
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
          this.resolveReconnectWaiters();
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
      }, HANDSHAKE_TIMEOUT_MS);

      const handler = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString("utf-8")) as Frame;
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
        caps: this.cfg.caps,
        sdkVersion: SDK_VERSION,
      };
      if (this.cfg.instructions) connectParams.instructions = this.cfg.instructions;
      if (this.cfg.tools && this.cfg.tools.length > 0) connectParams.tools = this.cfg.tools;
      if (this.cfg.blueprints && this.cfg.blueprints.length > 0) {
        connectParams.blueprints = this.cfg.blueprints.map(resolveBlueprintPath);
      }
      if (this.cfg.skills && this.cfg.skills.length > 0) connectParams.skills = this.cfg.skills;
      if (this.fsProbeMarker) connectParams.fsProbe = this.fsProbeMarker;
      ws.send(JSON.stringify({ type: "req", id, method: "connect", params: connectParams }));
    });
  }

  // ─── Internal: message handling ──────────────────────────────────────────────

  private attachHandlers(ws: WebSocket): void {
    ws.on("message", (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString("utf-8")) as Frame;

      // res: correlate with pending requests
      if (frame.type === "res" && frame.id) {
        const req = this.pending.get(frame.id);
        if (!req) return;
        this.pending.delete(frame.id);
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
        code === 1001 && reason?.toString("utf-8").includes("replaced");

      if (isEvicted) {
        this.intentionalClose = true;
        this.rejectReconnectWaiters(new Error("evicted"));
        this.evictedHandler?.();
        return;
      }

      // Ignore close events from stale connections (rare race condition).
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
          )
          .catch((sendErr: Error) => {
            console.error(`[endpoint-client] failed to send tool_response for ${payload.id}: ${sendErr.message}`);
          });
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
      case "file_fetch": {
        const reqId = frame.id;
        if (!reqId) break;
        const payload = frame.payload as FileFetchRequest;
        void this.handleFileFetch(reqId, payload);
        break;
      }
      case "dir_list": {
        const reqId = frame.id;
        if (!reqId) break;
        const payload = frame.payload as DirListRequest;
        void this.handleDirList(reqId, payload);
        break;
      }
      case "file_push": {
        const reqId = frame.id;
        if (!reqId) break;
        const payload = frame.payload as FilePushRequest;
        void this.handleFilePush(reqId, payload);
        break;
      }
      case "fs_probe": {
        const reqId = frame.id;
        if (!reqId) break;
        const payload = frame.payload as FsProbeRequest;
        void this.handleFsProbe(reqId, payload);
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
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

  private waitForConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.intentionalClose) return Promise.reject(new Error("not connected"));
    return new Promise((resolve, reject) => {
      this.reconnectWaiters.push({ resolve, reject });
    });
  }

  private resolveReconnectWaiters(): void {
    const waiters = this.reconnectWaiters.splice(0);
    for (const w of waiters) w.resolve();
  }

  private rejectReconnectWaiters(err: Error): void {
    const waiters = this.reconnectWaiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  private onDisconnect(): void {
    this.ws = null;
    this.stopHeartbeat();
    this.rejectAllPending(new Error("disconnected"));
    if (!this.intentionalClose) this.scheduleReconnect();
  }

  private rejectAllPending(err: Error): void {
    for (const [, req] of this.pending) {
      req.reject(err);
    }
    this.pending.clear();
  }

  private async handleFileFetch(reqId: string, payload: FileFetchRequest): Promise<void> {
    try {
      const localPath = payload.path;
      if (!path.isAbsolute(localPath)) {
        await this.toolResponse({ id: reqId, success: false, error: `path must be absolute, got: "${localPath}"` });
        return;
      }
      if (!fs.existsSync(localPath)) {
        await this.toolResponse({ id: reqId, success: false, error: `file not found: ${localPath}` });
        return;
      }
      const fileBuffer = fs.readFileSync(localPath);
      const fileName = path.basename(localPath);

      const form = new FormData();
      form.append("file", new Blob([fileBuffer]), fileName);

      const res = await fetch(payload.upload_url, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        await this.toolResponse({ id: reqId, success: false, error: `upload failed: ${res.status}` });
        return;
      }
      const result = await res.json() as Record<string, unknown>;
      await this.toolResponse({ id: reqId, success: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[endpoint] file_fetch error:", msg);
      await this.toolResponse({ id: reqId, success: false, error: msg }).catch(() => {});
    }
  }

  private async handleDirList(reqId: string, payload: DirListRequest): Promise<void> {
    try {
      const dirPath = payload.path;
      if (!path.isAbsolute(dirPath)) {
        await this.toolResponse({ id: reqId, success: false, error: `path must be absolute, got: "${dirPath}"` });
        return;
      }
      if (!fs.existsSync(dirPath)) {
        await this.toolResponse({ id: reqId, success: false, error: `directory not found: ${dirPath}` });
        return;
      }
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        await this.toolResponse({ id: reqId, success: false, error: `not a directory: ${dirPath}` });
        return;
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const result = {
        entries: entries
          .filter((e) => e.isFile() || e.isDirectory())
          .map((e) => {
            const fullPath = path.join(dirPath, e.name);
            try {
              const s = fs.statSync(fullPath);
              return {
                name: e.name,
                type: e.isDirectory() ? "dir" : "file",
                size: s.size,
                mtime: s.mtime.toISOString(),
              };
            } catch {
              return { name: e.name, type: e.isDirectory() ? "dir" : "file", size: 0 };
            }
          }),
      };
      await this.toolResponse({ id: reqId, success: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[endpoint] dir_list error:", msg);
      await this.toolResponse({ id: reqId, success: false, error: msg }).catch(() => {});
    }
  }

  private async handleFilePush(reqId: string, payload: FilePushRequest): Promise<void> {
    try {
      const targetPath = payload.target_path;
      if (!path.isAbsolute(targetPath)) {
        await this.toolResponse({ id: reqId, success: false, error: `target_path must be absolute, got: "${targetPath}"` });
        return;
      }
      const dir = path.dirname(targetPath);
      fs.mkdirSync(dir, { recursive: true });

      if (payload.local_source) {
        if (!path.isAbsolute(payload.local_source)) {
          await this.toolResponse({ id: reqId, success: false, error: `local_source must be absolute, got: "${payload.local_source}"` });
          return;
        }
        fs.copyFileSync(payload.local_source, targetPath);
        const stat = fs.statSync(targetPath);
        await this.toolResponse({ id: reqId, success: true, result: { size: stat.size } });
        return;
      }

      if (!payload.url) {
        await this.toolResponse({ id: reqId, success: false, error: "neither url nor local_source provided" });
        return;
      }
      const res = await fetch(payload.url);
      if (!res.ok) {
        await this.toolResponse({ id: reqId, success: false, error: `download failed: ${res.status}` });
        return;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(targetPath, buffer);
      await this.toolResponse({ id: reqId, success: true, result: { size: buffer.length } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[endpoint] file_push error:", msg);
      await this.toolResponse({ id: reqId, success: false, error: msg }).catch(() => {});
    }
  }

  private async handleFsProbe(reqId: string, payload: FsProbeRequest): Promise<void> {
    try {
      if (!path.isAbsolute(payload.path)) {
        await this.toolResponse({ id: reqId, success: true, result: { found: false, content: "" } });
        return;
      }
      if (fs.existsSync(payload.path)) {
        const content = fs.readFileSync(payload.path, "utf-8");
        await this.toolResponse({ id: reqId, success: true, result: { found: true, content } });
      } else {
        await this.toolResponse({ id: reqId, success: true, result: { found: false, content: "" } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.toolResponse({ id: reqId, success: true, result: { found: false, content: "" } }).catch(() => {});
      console.error("[endpoint] fs_probe error:", msg);
    }
  }

  private writeFsProbeFile(): FsProbeMarker | null {
    try {
      const nonce = crypto.randomUUID();
      const probePath = path.join(os.tmpdir(), `ailo-ep-${this.cfg.endpointId}.probe`);
      fs.writeFileSync(probePath, nonce, "utf-8");
      return { path: probePath, nonce };
    } catch (err) {
      console.error("[endpoint] failed to write fs probe file:", err);
      return null;
    }
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
