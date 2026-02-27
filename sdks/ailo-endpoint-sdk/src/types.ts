// ─── Content types ────────────────────────────────────────────────────────────

export type MediaData = {
  type: string;
  url?: string;
  path?: string;
  base64?: string;
  mime?: string;
  name?: string;
};

export type ContentPart = {
  type: "text" | "image" | "audio" | "video" | "pdf" | "file";
  text?: string;
  media?: MediaData;
};

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function mediaPart(
  type: "image" | "audio" | "video" | "pdf" | "file",
  media: MediaData,
): ContentPart {
  return { type, media };
}

// ─── Context tags ─────────────────────────────────────────────────────────────

export type ContextTag = {
  kind: string;
  value: string;
  /** 参与流分组，同一组消息共享历史、一起归纳 */
  groupWith: boolean;
  /** 回复/控制时传给工具的参数，不参与语义展示和向量嵌入 */
  passToTool?: boolean;
};

// ─── Skill metadata ──────────────────────────────────────────────────────────

/** A skill loaded from a local SKILL.md file and reported to the brain at connect time. */
export type SkillMeta = {
  name: string;
  description: string;
  content: string;
};

// ─── Tool capability declaration ─────────────────────────────────────────────

/** Describes a tool this endpoint can execute on behalf of the agent */
export type ToolCapability = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // JSON Schema
};

// ─── Capability constants ─────────────────────────────────────────────────────

export const CAP_MESSAGE = "message";
export const CAP_WORLD_UPDATE = "world_update";
export const CAP_TOOL_EXECUTE = "tool_execute";
export const CAP_INTENT = "intent";
export const CAP_SIGNAL = "signal";

// ─── Inbound message types (endpoint → server) ────────────────────────────────

/** Message sent via endpoint.accept. Stream grouping and reply routing via contextTags (groupWith, passToTool). */
export type AcceptMessage = {
  content: ContentPart[];
  contextTags: ContextTag[];
  requiresResponse?: boolean;
};

/** Payload for world_update */
export type WorldUpdatePayload = {
  mode: string;
  obstacles?: [number, number, number]; // front, left, right distances (cm)
  pir_active?: boolean;
  image_base64?: string; // JPEG frame for scene understanding
  voice_text?: string;   // Whisper transcription
  reason?: string;       // "frame_diff"|"voice"|"pir_wake"|"mode_changed"|"reconnect"
};

/** Payload for tool_response */
export type ToolResponsePayload = {
  id: string;      // correlates to incoming ToolRequestPayload.id
  success: boolean;
  result?: unknown;
  error?: string;
  /** Unified content format (same as AcceptMessage.content). Preferred over result when present. */
  content?: ContentPart[];
};

// ─── Outbound message types (server → endpoint) ───────────────────────────────

export type Point2D = { x: number; y: number };

export type EntityPayload = {
  type: string;
  position: Point2D;
  size: number;
  confidence?: number;
  source?: string;
};

/** Received via world_enrichment event */
export type WorldEnrichmentPayload = {
  entities: EntityPayload[];
  scene_description?: string;
};

/** Received via intent event */
export type IntentPayload = {
  action: string;   // "sleep"|"scan"|"converse"|"follow"|"patrol"|"clean"|"low_balance"
  target?: EntityPayload;
  params?: Record<string, unknown>;
};

/** Received via tool_request event */
export type ToolRequestPayload = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

/** Received via stream event — carries live text chunks from the agent */
export type StreamPayload = {
  streamId: string;
  action: "start" | "chunk" | "end";
  text?: string;           // present when action="chunk"
  correlationId?: string;  // links to the accept/world_update that triggered the stream
};

// ─── Tool handler ─────────────────────────────────────────────────────────────

/** Tool handler return type: ContentPart[] for multimodal results, or any other value for legacy text results. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>;

// ─── Storage interface ────────────────────────────────────────────────────────

export interface EndpointStorage {
  getData(key: string): Promise<string | null>;
  setData(key: string, value: string): Promise<void>;
  deleteData(key: string): Promise<void>;
}

// ─── Health status ────────────────────────────────────────────────────────────

export type HealthStatus = "connected" | "reconnecting" | "error";

// ─── Utilities ────────────────────────────────────────────────────────────────

export function getWorkDir(): string | null {
  return process.env.AILO_MCP_WORKDIR || null;
}
