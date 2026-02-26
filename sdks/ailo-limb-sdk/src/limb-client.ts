import WebSocket from "ws";
import type { Percept, LimbStorage } from "./types.js";

const SDK_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

type Frame = {
  type: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
  event?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LimbHealthStatus = "connected" | "reconnecting" | "error";

export interface LimbClientConfig {
  url: string;
  token: string;
  channel: string;
  displayName: string;
  defaultRequiresResponse?: boolean;
  instructions?: string;
}

export class LimbClient implements LimbStorage {
  private ws: WebSocket | null = null;
  private cfg: LimbClientConfig;
  private reqId = 0;
  private pending = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;

  constructor(config: LimbClientConfig) {
    this.cfg = config;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    await this.dial();
  }

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
          frame.ok ? resolve() : reject(new Error((frame.error?.message) ?? "connect rejected"));
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({
        type: "req", id, method: "connect",
        params: {
          role: "channel",
          token: this.cfg.token,
          channel: this.cfg.channel,
          displayName: this.cfg.displayName,
          defaultRequiresResponse: this.cfg.defaultRequiresResponse ?? true,
          instructions: this.cfg.instructions ?? "",
          sdkVersion: SDK_VERSION,
        },
      }));
    });
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on("message", (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Frame;

      // res：普通请求响应
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
    });

    ws.on("close", () => this.onDisconnect());
    ws.on("pong", () => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    });
  }

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

  async percept(p: Percept): Promise<void> {
    await this.request("channel.accept", {
      content: p.content,
      contextTags: p.contextTags,
      ...(p.requiresResponse !== undefined ? { requiresResponse: p.requiresResponse } : {}),
    });
  }

  async getData(key: string): Promise<string | null> {
    const res = await this.request<{ found: boolean; value?: string }>("channel.data.get", { key });
    return res.found ? (res.value ?? null) : null;
  }

  async setData(key: string, value: string): Promise<void> {
    await this.request("channel.data.set", { key, value });
  }

  async deleteData(key: string): Promise<void> {
    await this.request("channel.data.delete", { key });
  }

  reportHealth(status: LimbHealthStatus, detail?: string): void {
    const params: Record<string, unknown> = { status };
    if (detail) params.detail = detail;
    this.request("channel.health", params).catch(() => {});
  }

  sendLog(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    const params: Record<string, unknown> = { level, message };
    if (data && Object.keys(data).length > 0) params.data = data;
    this.request("channel.log", params).catch(() => {});
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        console.error("[limb-client] pong timeout, closing");
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
    console.error(`[limb-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial().catch((err) => {
        console.error("[limb-client] reconnect failed:", (err as Error).message);
        this.scheduleReconnect();
      });
    }, delay);
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    this.rejectAllPending(new Error("client closed"));
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}
