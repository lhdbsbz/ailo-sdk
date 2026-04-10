import WebSocket from "ws";
import type {
  AcceptMessage,
  ToolResponsePayload,
  WorldEnrichmentPayload,
  IntentPayload,
  ToolRequestPayload,
  StreamPayload,
  ToolCapability,
  SkillMeta,
  EndpointUpdateParams,
  FsProbeMarker,
} from "./types.js";
import { EndpointError } from "./errors.js";
import type { Logger } from "./logger.js";
import { ConsoleLogger } from "./logger.js";
import { ConnectionFSM, type ConnectionState, type StateChangeListener } from "./connection-state.js";
import { writeFsProbeFile, unlinkFsProbeFile } from "./endpoint-client-fs.js";
import { dispatchEndpointEvent, type WsFrame } from "./endpoint-client-events.js";

const SDK_VERSION = "1.0.0";

export interface EndpointClientOptions {
  handshakeTimeout?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  offlineBufferSize?: number;
  logger?: Logger;
}

const DEFAULT_OPTIONS: Required<Omit<EndpointClientOptions, 'logger'>> & { logger: Logger } = {
  handshakeTimeout: 30_000,
  heartbeatInterval: 30_000,
  heartbeatTimeout: 10_000,
  reconnectBaseDelay: 1_000,
  reconnectMaxDelay: 60_000,
  offlineBufferSize: 200,
  logger: new ConsoleLogger('[endpoint]'),
};

export const RECONNECT_COOLDOWN_MS = 1000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type ToolRequestHandler = (payload: ToolRequestPayload) => Promise<unknown>;
export type IntentHandler = (payload: IntentPayload) => void;
export type WorldEnrichmentHandler = (payload: WorldEnrichmentPayload) => void;
export type StreamHandler = (payload: StreamPayload) => void;
export type SignalHandler = (signal: string, data: unknown) => void;
export type EvictedHandler = () => void;

export interface EndpointClientConfig {
  url: string;
  apiKey: string;
  endpointId: string;
  caps: string[];
  tools?: ToolCapability[];
  mcpTools?: ToolCapability[];
  instructions?: string;
  skills?: SkillMeta[];
  offlineBufferSize?: number;
}

export type ConnectionOverrides = Partial<
  Pick<EndpointClientConfig, "url" | "apiKey" | "endpointId">
>;

export class EndpointClient {
  private ws: WebSocket | null = null;
  private cfg: EndpointClientConfig;
  private opts: Required<Omit<EndpointClientOptions, 'logger'>> & { logger: Logger };
  private fsm: ConnectionFSM;
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
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

  constructor(config: EndpointClientConfig, options?: EndpointClientOptions) {
    this.cfg = config;
    this.opts = {
      handshakeTimeout: options?.handshakeTimeout ?? DEFAULT_OPTIONS.handshakeTimeout,
      heartbeatInterval: options?.heartbeatInterval ?? DEFAULT_OPTIONS.heartbeatInterval,
      heartbeatTimeout: options?.heartbeatTimeout ?? DEFAULT_OPTIONS.heartbeatTimeout,
      reconnectBaseDelay: options?.reconnectBaseDelay ?? DEFAULT_OPTIONS.reconnectBaseDelay,
      reconnectMaxDelay: options?.reconnectMaxDelay ?? DEFAULT_OPTIONS.reconnectMaxDelay,
      offlineBufferSize: options?.offlineBufferSize ?? DEFAULT_OPTIONS.offlineBufferSize,
      logger: options?.logger ?? DEFAULT_OPTIONS.logger,
    };
    this.offlineBufferMax = config.offlineBufferSize ?? this.opts.offlineBufferSize;
    this.fsm = new ConnectionFSM();
    this.fsProbeMarker = writeFsProbeFile(this.cfg.endpointId, this.opts.logger);

    this.fsm.onStateChange((transition) => {
      this.opts.logger.debug('state_change', {
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
      });
    });
  }

  get state(): ConnectionState {
    return this.fsm.state;
  }

  get isConnected(): boolean {
    return this.fsm.isConnected;
  }

  onStateChange(listener: StateChangeListener): () => void {
    return this.fsm.onStateChange(listener);
  }

  setLogger(logger: Logger): void {
    this.opts.logger = logger;
  }

  async connect(): Promise<void> {
    if (!this.fsm.canTransitionTo('connecting')) {
      throw EndpointError.notConnected();
    }
    this.fsm.transition('connecting', 'user initiated');
    await this.dial();
  }

  close(): void {
    if (this.fsm.state === 'disconnected') return;
    
    this.fsm.transition('closing', 'user close');
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    this.rejectAllPending(new Error("client closed"));
    this.rejectReconnectWaiters(new Error("client closed"));
    this.offlineBuffer.length = 0;
    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.fsProbeMarker) {
      unlinkFsProbeFile(this.fsProbeMarker.path);
      this.fsProbeMarker = null;
    }
    this.fsm.forceTransition('disconnected', 'close complete');
  }

  async reconnect(
    skills?: SkillMeta[],
    connectionOverrides?: ConnectionOverrides,
    tools?: ToolCapability[],
    mcpTools?: ToolCapability[],
  ): Promise<void> {
    if (skills !== undefined) this.cfg = { ...this.cfg, skills };
    if (tools !== undefined) this.cfg = { ...this.cfg, tools };
    if (mcpTools !== undefined) this.cfg = { ...this.cfg, mcpTools };
    if (connectionOverrides) {
      const { url, apiKey, endpointId } = connectionOverrides;
      if (url !== undefined) this.cfg = { ...this.cfg, url };
      if (apiKey !== undefined) this.cfg = { ...this.cfg, apiKey };
      if (endpointId !== undefined) this.cfg = { ...this.cfg, endpointId };
    }
    
    this.fsm.forceTransition('closing', 'reconnect initiated');
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
    this.fsm.forceTransition('disconnected', 'reconnect cleanup');
    this.reconnectAttempt = 0;
    
    if (connectionOverrides) {
      await new Promise((r) => setTimeout(r, RECONNECT_COOLDOWN_MS));
    }
    await this.connect();
  }

  async update(params: EndpointUpdateParams): Promise<void> {
    await this.request("endpoint.update", params);
  }

  onToolRequest(handler: ToolRequestHandler): this {
    this.toolRequestHandler = handler;
    return this;
  }

  onIntent(handler: IntentHandler): this {
    this.intentHandler = handler;
    return this;
  }

  onWorldEnrichment(handler: WorldEnrichmentHandler): this {
    this.worldEnrichmentHandler = handler;
    return this;
  }

  onStream(handler: StreamHandler): this {
    this.streamHandler = handler;
    return this;
  }

  onSignal(signal: string, handler: SignalHandler): this {
    const list = this.signalHandlers.get(signal) ?? [];
    list.push(handler);
    this.signalHandlers.set(signal, list);
    return this;
  }

  onEvicted(handler: EvictedHandler): this {
    this.evictedHandler = handler;
    return this;
  }

  async accept(msg: AcceptMessage): Promise<void> {
    if (!this.fsm.isConnected) {
      if (this.fsm.state === 'closing' || this.fsm.state === 'disconnected' || this.offlineBufferMax <= 0) {
        throw EndpointError.notConnected();
      }
      if (this.offlineBuffer.length >= this.offlineBufferMax) {
        throw new Error(`offline buffer full (${this.offlineBufferMax})`);
      }
      this.offlineBuffer.push(msg);
      return;
    }
    await this.acceptDirect(msg);
  }

  async toolResponse(payload: ToolResponsePayload): Promise<void> {
    if (!this.fsm.isConnected) {
      if (this.fsm.state !== 'closing' && this.fsm.state !== 'disconnected') {
        await this.waitForConnection();
      }
    }
    await this.request("tool_response", payload as unknown as Record<string, unknown>);
  }

  sendSignal(signal: string, data?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "signal", id: signal, payload: data }));
  }

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.url);
      let settled = false;
      const settle = (ok: boolean, err?: unknown) => {
        if (settled) return;
        settled = true;
        if (ok) {
          this.fsm.transition('connected', 'handshake complete');
          resolve();
        } else {
          this.fsm.transition('disconnected', 'dial failed');
          reject(err);
        }
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

      ws.on("error", (err) => {
        this.opts.logger.error('ws_error', { error: err.message });
        settle(false, EndpointError.network('WebSocket error', err));
      });
      ws.on("close", () => settle(false, EndpointError.network("closed before handshake")));
    });
  }

  private handshake(ws: WebSocket): Promise<void> {
    const id = `connect-${++this.reqId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", handler);
        this.opts.logger.warn('handshake_timeout', { timeout: this.opts.handshakeTimeout });
        reject(EndpointError.timeout("handshake timeout"));
      }, this.opts.handshakeTimeout);

      const handler = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString("utf-8")) as WsFrame;
        if (frame.type === "res" && frame.id === id) {
          clearTimeout(timer);
          ws.off("message", handler);
          if (frame.ok) {
            resolve();
          } else {
            const errMsg = frame.error?.message ?? "connect rejected";
            this.opts.logger.error('handshake_failed', { error: errMsg });
            if (frame.error?.code === 'AUTH_FAILED') {
              reject(EndpointError.auth(errMsg));
            } else {
              reject(EndpointError.handshakeFailed(errMsg));
            }
          }
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
      if (this.cfg.mcpTools && this.cfg.mcpTools.length > 0) connectParams.mcpTools = this.cfg.mcpTools;
      if (this.cfg.skills && this.cfg.skills.length > 0) connectParams.skills = this.cfg.skills;
      if (this.fsProbeMarker) connectParams.fsProbe = this.fsProbeMarker;
      ws.send(JSON.stringify({ type: "req", id, method: "connect", params: connectParams }));
    });
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on("message", (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString("utf-8")) as WsFrame;

      if (frame.type === "res" && frame.id) {
        const req = this.pending.get(frame.id);
        if (!req) return;
        this.pending.delete(frame.id);
        frame.ok
          ? req.resolve(frame.payload ?? {})
          : req.reject(new Error(frame.error?.message ?? "request failed"));
        return;
      }

      if (frame.type === "event") {
        dispatchEndpointEvent(frame, {
          toolRequestHandler: this.toolRequestHandler,
          intentHandler: this.intentHandler,
          worldEnrichmentHandler: this.worldEnrichmentHandler,
          streamHandler: this.streamHandler,
          sendToolResponse: (p) => this.toolResponse(p),
          logger: this.opts.logger,
        });
        return;
      }

      if (frame.type === "signal" && frame.id) {
        const handlers = this.signalHandlers.get(frame.id);
        if (handlers) {
          for (const h of handlers) h(frame.id, frame.payload);
        }
        return;
      }
    });

    ws.on("close", (code, reason) => {
      const isEvicted = code === 1001 && reason?.toString("utf-8").includes("replaced");

      if (isEvicted) {
        this.opts.logger.warn('evicted', { code, reason: reason.toString() });
        this.fsm.forceTransition('disconnected', 'evicted');
        this.rejectReconnectWaiters(EndpointError.evicted());
        this.evictedHandler?.();
        return;
      }

      if (ws !== this.ws) return;

      this.onDisconnect();
    });
    ws.on("pong", () => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    });
  }

  private request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(EndpointError.notConnected());
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
    await this.request("endpoint.accept", params);
  }

  private flushOfflineBuffer(): void {
    if (this.offlineBuffer.length === 0) return;
    const buffered = this.offlineBuffer.splice(0);
    this.opts.logger.info('flushing_offline_buffer', { count: buffered.length });
    for (const msg of buffered) {
      this.acceptDirect(msg).catch((err) =>
        this.opts.logger.error('replay_failed', { error: err.message }),
      );
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        this.opts.logger.error('pong_timeout', { timeout: this.opts.heartbeatTimeout });
        this.ws?.terminate();
      }, this.opts.heartbeatTimeout);
    }, this.opts.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private waitForConnection(): Promise<void> {
    if (this.fsm.isConnected) return Promise.resolve();
    if (this.fsm.state === 'closing' || this.fsm.state === 'disconnected') {
      return Promise.reject(EndpointError.notConnected());
    }
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
    
    if (this.fsm.state !== 'closing' && this.fsm.state !== 'disconnected') {
      this.fsm.transition('reconnecting', 'unexpected disconnect');
      this.scheduleReconnect();
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, req] of this.pending) {
      req.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.opts.reconnectBaseDelay * 2 ** this.reconnectAttempt, this.opts.reconnectMaxDelay);
    this.reconnectAttempt++;
    this.opts.logger.info('scheduling_reconnect', { delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.fsm.transition('connecting', 'reconnect attempt');
      this.dial().catch((err) => {
        this.opts.logger.error('reconnect_failed', { error: err.message });
        this.fsm.transition('reconnecting', 'reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }
}
