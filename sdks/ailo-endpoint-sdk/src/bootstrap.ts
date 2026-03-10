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
  EndpointUpdateParams,
  HealthStatus,
  ToolHandler,
  ToolCapability,
  SkillMeta,
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
  /** Incrementally update capabilities (tools, blueprints, skills, caps) without reconnecting */
  update(params: EndpointUpdateParams): Promise<void>;
  client: EndpointClient;
}

export interface EndpointHandler {
  start(ctx: EndpointContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface EndpointConfig {
  /** Capability list (default: ["message","tool_execute"]) */
  caps?: string[];
  /** The endpoint handler (feishu, webchat, etc.) */
  handler: EndpointHandler;
  /** Tool declarations reported to the server at connect time */
  tools?: ToolCapability[];
  /** Map of tool name → handler function for automatic tool_request dispatch */
  toolHandlers?: Record<string, ToolHandler>;
  /** Fallback for tool names not in toolHandlers (e.g. MCP serverName:toolName). Throw or return undefined to reject as unknown. */
  onUnknownTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isContentPartType(value: unknown): value is ContentPart["type"] {
  return value === "text" || value === "image" || value === "audio" ||
    value === "video" || value === "pdf" || value === "file";
}

function tmpExtensionForMedia(mime: string | undefined, type: Exclude<ContentPart["type"], "text">): string {
  const normalized = (mime || "").toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return ".wav";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "application/pdf") return ".pdf";
  if (type === "image") return ".png";
  if (type === "audio") return ".mp3";
  if (type === "video") return ".mp4";
  if (type === "pdf") return ".pdf";
  return ".bin";
}

function materializeInlineMedia(data: string, mime: string | undefined, type: Exclude<ContentPart["type"], "text">): string {
  const dir = path.join(os.tmpdir(), "ailo_mcp_media");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `${Date.now()}_${Math.random().toString(36).slice(2)}${tmpExtensionForMedia(mime, type)}`,
  );
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  return filePath;
}

export function runEndpoint(config: EndpointConfig): void {
  const { handler } = config;

  const ailoWsUrl = config.ailoWsUrl ?? process.env.AILO_WS_URL ?? "";
  const ailoApiKey = config.ailoApiKey ?? process.env.AILO_API_KEY ?? "";
  const endpointId = config.endpointId ?? process.env.AILO_ENDPOINT_ID ?? "";
  const caps = config.caps ?? ["message", "tool_execute"];

  if (!ailoWsUrl || !ailoApiKey || !endpointId) {
    console.error(
      "[endpoint] Missing ailoWsUrl, ailoApiKey or endpointId. " +
      "Please pass these values in the config or set them via the config file.",
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
            sourcePath: absPath,
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
      return Array.isArray(v) && v.every((part) => typeof part === "object" && part !== null && "type" in part);
    }

    function stringifyStructured(value: unknown): string {
      if (typeof value === "string") return value;
      try {
        const text = JSON.stringify(value);
        if (text !== undefined) return text;
      } catch {}
      return String(value);
    }

    function isMcpCallResult(value: unknown): value is Record<string, unknown> {
      return isRecord(value) && (
        Array.isArray(value.content) ||
        "structuredContent" in value ||
        "isError" in value
      );
    }

    function mcpItemToContentPart(item: unknown): ContentPart {
      if (!isRecord(item)) {
        return { type: "text", text: stringifyStructured(item) };
      }

      const rawType = item.type;
      if (!isContentPartType(rawType)) {
        return { type: "text", text: stringifyStructured(item) };
      }
      if (rawType === "text") {
        return { type: "text", text: stringifyStructured(item.text ?? "") };
      }

      const mediaSource = isRecord(item.media) ? item.media : item;
      const media: Record<string, unknown> = { type: rawType };
      if (typeof mediaSource.fileRef === "string") media.fileRef = mediaSource.fileRef;
      if (typeof mediaSource.path === "string") media.path = mediaSource.path;
      if (typeof mediaSource.url === "string") media.url = mediaSource.url;
      if (typeof mediaSource.sourcePath === "string") media.sourcePath = mediaSource.sourcePath;

      const mime =
        typeof mediaSource.mime === "string"
          ? mediaSource.mime
          : typeof mediaSource.mimeType === "string"
            ? mediaSource.mimeType
            : "";
      if (mime) media.mime = mime;
      if (typeof mediaSource.name === "string") media.name = mediaSource.name;

      if (!media.path && !media.url && !media.fileRef && typeof mediaSource.data === "string") {
        const localPath = materializeInlineMedia(mediaSource.data, mime || undefined, rawType);
        media.path = localPath;
        media.mime = mime || inferMime(localPath);
        media.name = typeof media.name === "string" && media.name
          ? media.name
          : path.basename(localPath);
      }

      if (!media.path && !media.url && !media.fileRef) {
        return { type: "text", text: stringifyStructured(item) };
      }
      if (!media.mime && typeof media.path === "string") media.mime = inferMime(media.path);
      if (!media.name && typeof media.path === "string") media.name = path.basename(media.path);

      return { type: rawType, media: media as ContentPart["media"] };
    }

    function adaptMcpCallResult(result: Record<string, unknown>): ContentPart[] {
      const parts: ContentPart[] = [];
      if (Array.isArray(result.content)) {
        result.content.forEach((item) => parts.push(mcpItemToContentPart(item)));
      }
      if ("structuredContent" in result && result.structuredContent !== undefined) {
        parts.push({ type: "text", text: stringifyStructured(result.structuredContent) });
      }
      return parts;
    }

    function extractMcpError(result: Record<string, unknown>): string {
      if (Array.isArray(result.content)) {
        const text = result.content
          .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text.trim() : ""))
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
      if ("structuredContent" in result && result.structuredContent !== undefined) {
        return stringifyStructured(result.structuredContent);
      }
      return "MCP tool call failed";
    }

    async function normalizeToolResult(result: unknown): Promise<ContentPart[] | unknown> {
      if (isContentParts(result)) {
        await autoUploadMedia(result);
        return result;
      }
      if (isMcpCallResult(result)) {
        if (result.isError === true) {
          throw new Error(extractMcpError(result));
        }
        const adapted = adaptMcpCallResult(result);
        await autoUploadMedia(adapted);
        return adapted;
      }
      return result;
    }

    // ── tool dispatch with middleware ──

    if (config.toolHandlers || config.onUnknownTool) {
      const handlers = config.toolHandlers ?? {};
      const onUnknown = config.onUnknownTool;
      client.onToolRequest(async (req) => {
        await resolveFileArgsInPlace(req.args);
        const fn = handlers[req.name];
        if (fn) {
          const result = await fn(req.args);
          return normalizeToolResult(result);
        }
        if (onUnknown) {
          const result = await onUnknown(req.name, req.args);
          return normalizeToolResult(result);
        }
        throw new Error(`unknown tool: ${req.name}`);
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
      update: (params) => client.update(params),
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

