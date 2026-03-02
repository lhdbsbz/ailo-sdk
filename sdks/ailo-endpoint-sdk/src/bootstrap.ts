/**
 * bootstrap.ts — High-level helper for launching endpoint processes.
 *
 * Wraps EndpointClient with automatic Blob upload/download middleware,
 * tool dispatch, skill loading, and graceful shutdown.
 *
 * @example
 * ```ts
 * runEndpoint({
 *   handler: new MyHandler(),
 *   displayName: "My Endpoint",
 *   caps: ["message", "tool_execute"],
 * });
 * ```
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EndpointClient } from "./endpoint-client.js";
import { loadSkills } from "./skill-loader.js";
import { parseFileRef, isFileRef } from "./fileref.js";
import { inferMime, classifyMedia } from "./media-util.js";
import type {
  AcceptMessage,
  ContentPart,
  EndpointStorage,
  HealthStatus,
  ToolHandler,
  ToolCapability,
  SkillMeta,
  MediaPushPayload,
} from "./types.js";

export interface EndpointContext {
  /** Submit a message (or perception signal) to the server. Media with local paths are auto-uploaded. */
  accept(msg: AcceptMessage): Promise<void>;
  storage: EndpointStorage;
  reportHealth(status: HealthStatus, detail?: string): void;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  sendSignal(signal: string, data?: unknown): void;
  onSignal(signal: string, callback: (data: unknown) => void): void;
  /** Upload a local file to the server's Blob store. Returns the FileRef URI. */
  uploadBlob(localPath: string): Promise<string>;
  /** Resolve a FileRef URI or Blob HTTP URL to a local file path */
  resolveToLocal(pathOrUrl: string): Promise<string>;
  /** Send a local file to the server via Blob upload + accept. Returns the FileRef URI. */
  sendFile(localPath: string, opts?: { requiresResponse?: boolean }): Promise<string>;
  /** Register a handler for media_push events */
  onMediaPush(handler: (payload: MediaPushPayload) => void | Promise<void>): void;
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
  /** Tool declarations reported to the server at connect time */
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
  /** Optional instructions describing this endpoint's environment or constraints */
  instructions?: string;
  /** Directories to scan for SKILL.md files (default: ["~/.agents/skills/"]) */
  skillDirs?: string[];
  /** When set, report these skills to the server instead of loading from skillDirs (enables "only report enabled skills") */
  skills?: SkillMeta[];
  /**
   * Called when the initial connection fails (defaults to process.exit(1) if not provided).
   * Recommended: wait with backoff, then call client.reconnect(undefined, latestConfig).
   * Re-read config on each retry to pick up hot-reloaded changes.
   */
  onConnectFailure?: (err: Error, client: EndpointClient) => void | Promise<void>;
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

  const skills =
    config.skills !== undefined
      ? config.skills
      : loadSkills(config.skillDirs);
  if (skills.length > 0) {
    console.log(`${tag} loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  }

  const client = new EndpointClient({
    url: ailoWsUrl,
    apiKey: ailoApiKey,
    endpointId,
    displayName: config.displayName,
    caps,
    tools: config.tools,
    instructions: config.instructions,
    blueprints: config.blueprints,
    skills,
  });

  const shutdown = (reason = "shutdown") => {
    console.log(`${tag} shutting down... (${reason})`);
    Promise.resolve(handler.stop()).catch(() => {});
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  client.onEvicted(() => {
    console.log(`${tag} evicted by a newer instance, exiting.`);
    Promise.resolve(handler.stop()).catch(() => {});
    process.exit(0);
  });

  (async () => {
    const ailoHttpBase = deriveHttpBase(ailoWsUrl);
    const blobUrlPrefix = `${ailoHttpBase}/api/blob/`;
    const mediaPushHandlers: Array<(payload: MediaPushPayload) => void | Promise<void>> = [];

    client.onMediaPush((payload) => {
      for (const h of mediaPushHandlers) {
        Promise.resolve(h(payload)).catch((err) => {
          console.error(`${tag} media_push handler error:`, err);
        });
      }
    });

    // ── blob helpers ──

    async function uploadBlob(localPath: string): Promise<string> {
      const absPath = path.resolve(localPath);
      const fileBuffer = fs.readFileSync(absPath);
      const fileName = path.basename(absPath);
      const form = new FormData();
      form.append("file", new Blob([fileBuffer]), fileName);
      const res = await fetch(`${ailoHttpBase}/api/blob/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ailoApiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`blob upload failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { file_ref: string };
      return json.file_ref;
    }

    async function downloadBlobToLocal(url: string): Promise<string> {
      const tmpDir = path.join(os.tmpdir(), "ailo_blob");
      fs.mkdirSync(tmpDir, { recursive: true });
      const fileName = url.split("/").pop() || `blob_${Date.now()}`;
      const tmpFile = path.join(tmpDir, `${Date.now()}_${fileName}`);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${ailoApiKey}` } });
      if (!res.ok) throw new Error(`blob download failed: ${res.status}`);
      fs.writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
      return tmpFile;
    }

    async function resolveToLocal(pathOrUrl: string): Promise<string> {
      if (isFileRef(pathOrUrl)) {
        const parsed = parseFileRef(pathOrUrl);
        if (parsed.type === "endpoint" && parsed.endpointId === endpointId) return parsed.path!;
        if (parsed.type === "blob") return downloadBlobToLocal(`${ailoHttpBase}/api/blob/${parsed.blobId}`);
        return pathOrUrl;
      }
      if (pathOrUrl.startsWith(blobUrlPrefix)) return downloadBlobToLocal(pathOrUrl);
      return pathOrUrl;
    }

    // ── auto-upload: path → blob → fileRef (outbound middleware) ──

    async function autoUploadMedia(content: ContentPart[]): Promise<void> {
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part.media?.path) continue;
        const absPath = path.resolve(part.media.path);
        if (!fs.existsSync(absPath)) {
          throw new Error(`auto-upload: file not found: ${absPath}`);
        }
        const fileRef = await uploadBlob(absPath);
        content[i] = {
          ...part,
          media: {
            type: part.media.type,
            fileRef,
            mime: part.media.mime || inferMime(absPath),
            name: part.media.name || path.basename(absPath),
          },
        };
      }
    }

    // ── auto-resolve: blob URL → local path (inbound middleware) ──

    async function resolveFileArgsInPlace(args: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" && value.startsWith(blobUrlPrefix)) {
          try { args[key] = await downloadBlobToLocal(value); } catch { /* keep original */ }
        } else if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            if (typeof value[i] === "string" && (value[i] as string).startsWith(blobUrlPrefix)) {
              try { value[i] = await downloadBlobToLocal(value[i] as string); } catch { /* keep */ }
            } else if (typeof value[i] === "object" && value[i] !== null) {
              await resolveFileArgsInPlace(value[i] as Record<string, unknown>);
            }
          }
        } else if (typeof value === "object" && value !== null) {
          await resolveFileArgsInPlace(value as Record<string, unknown>);
        }
      }
    }

    function isContentParts(v: unknown): v is ContentPart[] {
      return Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && "type" in v[0];
    }

    // ── tool dispatch with middleware ──

    if (config.toolHandlers) {
      const handlers = config.toolHandlers;
      client.onToolRequest(async (req) => {
        const fn = handlers[req.name];
        if (!fn) throw new Error(`unknown tool: ${req.name}`);
        await resolveFileArgsInPlace(req.args);
        const result = await fn(req.args);
        if (isContentParts(result)) await autoUploadMedia(result);
        return result;
      });
    }

    // ── ctx ──

    const ctx: EndpointContext = {
      async accept(msg: AcceptMessage): Promise<void> {
        await autoUploadMedia(msg.content);
        return client.accept(msg);
      },
      storage: client,
      reportHealth: (status, detail) => client.reportHealth(status, detail),
      log: (level, message, data) => client.sendLog(level, message, data),
      sendSignal: (signal, data) => client.sendSignal(signal, data),
      onSignal: (signal, callback) => {
        client.onSignal(signal, (_sig, data) => callback(data));
      },
      uploadBlob,
      resolveToLocal,
      async sendFile(localPath: string, opts?: { requiresResponse?: boolean }): Promise<string> {
        const absPath = path.resolve(localPath);
        const fileRef = await uploadBlob(absPath);
        const mime = inferMime(absPath);
        const mediaType = classifyMedia(mime);
        await ctx.accept({
          content: [{ type: mediaType, media: { type: mediaType, fileRef, mime, name: path.basename(absPath) } }],
          contextTags: [],
          requiresResponse: opts?.requiresResponse ?? false,
        });
        return fileRef;
      },
      onMediaPush(handler) {
        mediaPushHandlers.push(handler);
      },
      client,
    };

    for (;;) {
      try {
        await client.connect();
        console.log(`${tag} Ailo WebSocket connected`);
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error(`${tag} Ailo WebSocket connect failed:`, e.message);
        if (config.onConnectFailure) {
          await Promise.resolve(config.onConnectFailure(e, client));
        } else {
          process.exit(1);
        }
      }
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

/** Derive HTTP base URL from WebSocket URL (ws://host:port/ws → http://host:port) */
function deriveHttpBase(wsUrl: string): string {
  let base = wsUrl.replace(/\/ws\/?$/, "");
  if (base.startsWith("wss://")) base = base.replace("wss://", "https://");
  else if (base.startsWith("ws://")) base = base.replace("ws://", "http://");
  return base;
}

