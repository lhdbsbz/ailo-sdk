import type {
  FileFetchRequest,
  DirListRequest,
  FilePushRequest,
  FsProbeRequest,
  IntentPayload,
  StreamPayload,
  ToolRequestPayload,
  ToolResponsePayload,
  WorldEnrichmentPayload,
} from "./types.js";
import type { Logger } from "./logger.js";
import type { ContentPart } from "./types.js";
import { toContentParts, stringifyValue } from "./content-parts.js";
import {
  handleEndpointDirList,
  handleEndpointFileFetch,
  handleEndpointFilePush,
  handleEndpointFsProbe,
} from "./endpoint-client-fs.js";

/** WebSocket JSON frame shape used by the endpoint client. */
export type WsFrame = {
  type: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
  event?: string;
  seq?: number;
};

export type EndpointEventDeps = {
  toolRequestHandler: ((payload: ToolRequestPayload) => Promise<unknown>) | null;
  intentHandler: ((payload: IntentPayload) => void) | null;
  worldEnrichmentHandler: ((payload: WorldEnrichmentPayload) => void) | null;
  streamHandler: ((payload: StreamPayload) => void) | null;
  sendToolResponse: (p: ToolResponsePayload) => Promise<void>;
  logger: Logger;
};

const MAX_TOOL_RESULT_BYTES = 64 * 1024;

function capToolContent(
  toolName: string,
  parts: ContentPart[] | undefined,
  logger: Logger,
): ContentPart[] | undefined {
  if (!parts) return parts;
  const serialized = parts.map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");
  if (serialized.length <= MAX_TOOL_RESULT_BYTES) return parts;
  const keep = Math.floor(MAX_TOOL_RESULT_BYTES / 2);
  const head = serialized.slice(0, keep);
  const tail = serialized.slice(-keep);
  logger.warn("tool_result_too_large", {
    tool: toolName,
    original_bytes: serialized.length,
    cap_bytes: MAX_TOOL_RESULT_BYTES,
  });
  const payload = JSON.stringify({
    ok: false,
    code: "result_too_large",
    truncated: true,
    tool: toolName,
    original_bytes: serialized.length,
    cap_bytes: MAX_TOOL_RESULT_BYTES,
    head,
    tail,
    hint: "结果超过 64KB 已被截断，请用更精确参数（如 read 的 limit/offset、grep 的 head_limit）重新调用；若是前台 bash 输出过大，改走 run_in_background:true + bash_output 增量读取",
  });
  return [{ type: "text", text: payload }];
}

/** Dispatches `event` frames from the gateway (tool_request, FS RPC, etc.). */
export function dispatchEndpointEvent(frame: WsFrame, deps: EndpointEventDeps): void {
  const send = (p: ToolResponsePayload) => deps.sendToolResponse(p);
  const { logger } = deps;

  switch (frame.event) {
    case "tool_request": {
      const payload = frame.payload as ToolRequestPayload;
      if (!deps.toolRequestHandler || !payload?.id) return;
      void deps
        .toolRequestHandler(payload)
        .then((result) => {
          const toolName = typeof payload.name === "string" ? payload.name : "unknown";
          const content = capToolContent(toolName, toContentParts(result), logger);
          return deps.sendToolResponse({
            id: payload.id,
            success: true,
            content,
          });
        })
        .catch((err: Error) =>
          deps.sendToolResponse({ id: payload.id, success: false, error: err.message }),
        )
        .catch((sendErr: Error) => {
          deps.logger.error("tool_response_failed", {
            toolId: payload.id,
            error: sendErr.message,
          });
        });
      break;
    }
    case "intent": {
      const payload = frame.payload as IntentPayload;
      deps.intentHandler?.(payload);
      break;
    }
    case "world_enrichment": {
      const payload = frame.payload as WorldEnrichmentPayload;
      deps.worldEnrichmentHandler?.(payload);
      break;
    }
    case "stream": {
      const payload = frame.payload as StreamPayload;
      deps.streamHandler?.(payload);
      break;
    }
    case "file_fetch": {
      const reqId = frame.id;
      if (!reqId) break;
      const payload = frame.payload as FileFetchRequest;
      void handleEndpointFileFetch(reqId, payload, send, logger);
      break;
    }
    case "dir_list": {
      const reqId = frame.id;
      if (!reqId) break;
      const payload = frame.payload as DirListRequest;
      void handleEndpointDirList(reqId, payload, send, logger);
      break;
    }
    case "file_push": {
      const reqId = frame.id;
      if (!reqId) break;
      const payload = frame.payload as FilePushRequest;
      void handleEndpointFilePush(reqId, payload, send, logger);
      break;
    }
    case "fs_probe": {
      const reqId = frame.id;
      if (!reqId) break;
      const payload = frame.payload as FsProbeRequest;
      void handleEndpointFsProbe(reqId, payload, send, logger);
      break;
    }
    default:
      break;
  }
}
