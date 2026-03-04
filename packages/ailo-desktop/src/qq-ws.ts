import WebSocket from "ws";
import {
  type QQConfig,
  type QQGatewayPayload,
  OP_DISPATCH,
  OP_HEARTBEAT,
  OP_IDENTIFY,
  OP_RESUME,
  OP_RECONNECT,
  OP_INVALID_SESSION,
  OP_HELLO,
  OP_HEARTBEAT_ACK,
  INTENT_PUBLIC_GUILD_MESSAGES,
  INTENT_DIRECT_MESSAGE,
  INTENT_GROUP_AND_C2C,
  DEFAULT_API_BASE,
  TOKEN_URL,
  RECONNECT_DELAYS,
  MAX_RECONNECT_ATTEMPTS,
} from "./qq-types.js";

type DispatchHandler = (event: string, data: any) => void;

export class QQGatewayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private closed = false;

  private accessToken: string = "";
  private tokenExpiresAt = 0;

  private onDispatch: DispatchHandler;
  private log: (level: string, msg: string, data?: Record<string, unknown>) => void;

  constructor(
    private config: QQConfig,
    onDispatch: DispatchHandler,
    log?: (level: string, msg: string, data?: Record<string, unknown>) => void,
  ) {
    this.onDispatch = onDispatch;
    this.log = log ?? ((level, msg, data) => console.log(`[qq-ws] [${level}] ${msg}`, data ?? ""));
  }

  private get apiBase(): string {
    return (this.config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  }

  async refreshToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
    });
    if (!res.ok) throw new Error(`QQ token refresh failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    this.log("info", "access token refreshed", { expires_in: body.expires_in });
    return this.accessToken;
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.refreshToken();

    const gatewayUrl = await this.fetchGatewayUrl();
    this.log("info", `connecting to gateway: ${gatewayUrl}`);
    this.createConnection(gatewayUrl);
  }

  private async fetchGatewayUrl(): Promise<string> {
    const token = await this.refreshToken();
    const res = await fetch(`${this.apiBase}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (!res.ok) throw new Error(`QQ gateway fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { url: string };
    return body.url;
  }

  private createConnection(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.log("info", "WebSocket connected");
      this.reconnectAttempts = 0;
    });

    ws.on("message", (raw: WebSocket.Data) => {
      try {
        const payload = JSON.parse(raw.toString("utf-8")) as QQGatewayPayload;
        this.handlePayload(payload);
      } catch (err) {
        this.log("error", "failed to parse WS message", { err: String(err) });
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.log("warn", `WebSocket closed: ${code} ${reason.toString("utf-8")}`);
      this.stopHeartbeat();
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.log("error", "WebSocket error", { err: err.message });
    });
  }

  private handlePayload(payload: QQGatewayPayload): void {
    if (payload.s != null) this.lastSeq = payload.s;

    switch (payload.op) {
      case OP_HELLO:
        this.startHeartbeat((payload.d as Record<string, unknown>)?.heartbeat_interval as number ?? 41250);
        if (this.sessionId) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case OP_DISPATCH:
        if (payload.t === "READY") {
          this.sessionId = (payload.d as Record<string, unknown>)?.session_id as string ?? null;
          this.log("info", "READY", { session_id: this.sessionId });
        }
        if (payload.t) {
          this.onDispatch(payload.t, payload.d);
        }
        break;

      case OP_HEARTBEAT_ACK:
        break;

      case OP_RECONNECT:
        this.log("info", "server requested reconnect");
        this.ws?.close(4000, "reconnect");
        break;

      case OP_INVALID_SESSION:
        this.log("warn", "invalid session, re-identifying");
        this.sessionId = null;
        this.lastSeq = null;
        setTimeout(() => this.sendIdentify(), 2000);
        break;

      default:
        this.log("debug", `unhandled op: ${payload.op}`, { d: payload.d });
    }
  }

  private sendIdentify(): void {
    const intents = INTENT_PUBLIC_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE | INTENT_GROUP_AND_C2C;
    this.send({
      op: OP_IDENTIFY,
      d: { token: `QQBot ${this.accessToken}`, intents, shard: [0, 1] },
    });
    this.log("debug", "sent IDENTIFY");
  }

  private sendResume(): void {
    this.send({
      op: OP_RESUME,
      d: { token: `QQBot ${this.accessToken}`, session_id: this.sessionId, seq: this.lastSeq },
    });
    this.log("debug", "sent RESUME");
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: OP_HEARTBEAT, d: this.lastSeq });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: QQGatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.log("error", "max reconnect attempts reached, giving up");
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1)] * 1000;
    this.reconnectAttempts++;
    this.log("info", `reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (!this.closed) {
        this.connect().catch((err) => this.log("error", "reconnect failed", { err: String(err) }));
      }
    }, delay);
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
  }
}
