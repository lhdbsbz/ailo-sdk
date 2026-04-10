import * as fs from "fs";
import * as path from "path";
import { EndpointClient } from "./endpoint-client.js";
import { createLocalEndpointStorage } from "./local-endpoint-storage.js";
import { loadSkills } from "./skill-loader.js";
import { BlobClient, deriveHttpBase } from "./blob-client.js";
import { autoUploadMedia, resolveFileArgsInPlace, resolveToLocal } from "./media-middleware.js";
import { normalizeToolResult } from "./tool-dispatch.js";
import { inferMime, classifyMedia } from "./media-util.js";
import { ConsoleLogger, type Logger, type LogLevel, type LogData } from "./logger.js";
import type {
  AcceptMessage,
  ContentPart,
  EndpointStorage,
  EndpointUpdateParams,
  ToolHandler,
  ToolCapability,
  SkillMeta,
} from "./types.js";

export interface EndpointContext {
  accept(msg: AcceptMessage): Promise<void>;
  storage: EndpointStorage;
  sendSignal(signal: string, data?: unknown): void;
  onSignal(signal: string, callback: (data: unknown) => void): void;
  uploadBlob(localPath: string): Promise<string>;
  resolveToLocal(pathOrUrl: string): Promise<string>;
  sendFile(localPath: string): Promise<string>;
  update(params: EndpointUpdateParams): Promise<void>;
  client: EndpointClient;
  log(level: LogLevel, message: string, data?: LogData): void;
  reportHealth(status: string): void;
}

export interface EndpointHandler {
  start(ctx: EndpointContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface EndpointConfig {
  caps?: string[];
  handler: EndpointHandler;
  tools?: ToolCapability[];
  mcpTools?: ToolCapability[];
  toolHandlers?: Record<string, ToolHandler>;
  onUnknownTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  ailoWsUrl?: string;
  ailoApiKey?: string;
  endpointId?: string;
  instructions?: string;
  skillDirs?: string[];
  skills?: SkillMeta[];
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
      "[endpoint] Missing ailoWsUrl, ailoApiKey or endpointId. " +
      "Please pass these values in the config or set them via the config file.",
    );
    process.exit(1);
  }

  const tag = `[${endpointId}]`;
  const logger = new ConsoleLogger(tag);

  const skills =
    config.skills !== undefined
      ? config.skills
      : loadSkills(config.skillDirs);
  if (skills.length > 0) {
    logger.info('skills_loaded', { count: skills.length, names: skills.map((s) => s.name).join(", ") });
  }

  const client = new EndpointClient({
    url: ailoWsUrl,
    apiKey: ailoApiKey,
    endpointId,
    caps,
    tools: config.tools,
    mcpTools: config.mcpTools,
    instructions: config.instructions,
    skills,
  }, { logger });

  const shutdown = (reason = "shutdown") => {
    logger.info('shutting_down', { reason });
    Promise.resolve(handler.stop()).catch(() => {});
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  client.onEvicted(() => {
    logger.warn('evicted', { message: 'evicted by a newer instance, exiting.' });
    Promise.resolve(handler.stop()).catch(() => {});
    process.exit(0);
  });

  (async () => {
    const ailoHttpBase = deriveHttpBase(ailoWsUrl);
    const blobUrlPrefix = `${ailoHttpBase}/api/blob/`;
    const blobClient = new BlobClient({ httpBase: ailoHttpBase, apiKey: ailoApiKey });

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

    if (config.toolHandlers || config.onUnknownTool) {
      const handlers = config.toolHandlers ?? {};
      const onUnknown = config.onUnknownTool;
      client.onToolRequest(async (req) => {
        await resolveFileArgsInPlace(req.args, blobClient, blobUrlPrefix);
        const fn = handlers[req.name];
        if (fn) {
          const result = await fn(req.args);
          return normalizeToolResult(result, blobClient);
        }
        if (onUnknown) {
          const result = await onUnknown(req.name, req.args);
          return normalizeToolResult(result, blobClient);
        }
        throw new Error(`unknown tool: ${req.name}`);
      });
    }

    const ctx: EndpointContext = {
      async accept(msg: AcceptMessage): Promise<void> {
        await autoUploadMedia(msg.content, blobClient);
        return client.accept(msg);
      },
      storage: createLocalEndpointStorage(endpointId),
      sendSignal: (signal, data) => client.sendSignal(signal, data),
      onSignal: (signal, callback) => {
        client.onSignal(signal, (_sig, data) => callback(data));
      },
      uploadBlob,
      resolveToLocal: (pathOrUrl) => resolveToLocal(pathOrUrl, blobClient, endpointId, blobUrlPrefix),
      async sendFile(localPath: string): Promise<string> {
        const absPath = path.resolve(localPath);
        const fileRef = await uploadBlob(absPath);
        const mime = inferMime(absPath);
        const mediaType = classifyMedia(mime);
        await ctx.accept({
          content: [{ type: mediaType, media: { type: mediaType, fileRef, mime, name: path.basename(absPath) } }],
          contextTags: [],
        });
        return fileRef;
      },
      update: (params) => client.update(params),
      client,
      log: (level, message, data) => logger[level](message, data),
      reportHealth: (status) => logger.info('health_report', { status }),
    };

    for (;;) {
      try {
        await client.connect();
        logger.info('connected', { message: 'Ailo WebSocket connected' });
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        logger.error('connect_failed', { error: e.message });
        if (config.onConnectFailure) {
          await Promise.resolve(config.onConnectFailure(e, client));
        } else {
          process.exit(1);
        }
      }
    }

    try {
      await handler.start(ctx);
      logger.info('handler_started', { message: 'handler started' });
    } catch (err) {
      logger.error('handler_start_failed', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  })();
}
