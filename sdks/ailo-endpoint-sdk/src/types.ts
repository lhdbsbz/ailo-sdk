// ─── Content types ────────────────────────────────────────────────────────────

export type MediaData = {
  type: string;
  /** FileRef URI (ailo://blob/... or ailo://ep:...) */
  fileRef?: string;
  /** Local file path. Auto-uploaded to Blob storage on outbound messages. */
  path?: string;
  /** External URL (e.g. CDN link). Passed through as-is. */
  url?: string;
  mime?: string;
  name?: string;
  /** Original path on the source endpoint before blob upload. Set by autoUploadMedia. */
  sourcePath?: string;
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
  /** When true, messages with matching tags are grouped into the same conversation stream */
  groupWith: boolean;
  /** When true, this tag's value is forwarded to tool calls as a parameter (e.g. chat_id for reply routing) */
  passToTool?: boolean;
};

// ─── Skill metadata ──────────────────────────────────────────────────────────

/** A skill loaded from a local SKILL.md file and reported to the server at connect time. */
export type SkillMeta = {
  name: string;
  description: string;
  content: string;
};

// ─── Tool capability declaration ─────────────────────────────────────────────

/** Describes a tool this endpoint can execute */
export type ToolCapability = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

// ─── Capability constants ─────────────────────────────────────────────────────

export const CAP_MESSAGE = "message";
export const CAP_TOOL_EXECUTE = "tool_execute";
export const CAP_INTENT = "intent";
export const CAP_SIGNAL = "signal";

// ─── Inbound message types (endpoint → server) ────────────────────────────────

export type AcceptMessage = {
  content: ContentPart[];
  contextTags: ContextTag[];
};

/** Payload for tool_response */
export type ToolResponsePayload = {
  id: string;
  success: boolean;
  error?: string;
  result?: unknown;
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

export type WorldEnrichmentPayload = {
  entities: EntityPayload[];
  scene_description?: string;
};

export type IntentPayload = {
  action: string;
  target?: EntityPayload;
  params?: Record<string, unknown>;
};

export type ToolRequestPayload = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type StreamPayload = {
  streamId: string;
  action: "start" | "chunk" | "end";
  text?: string;
  correlationId?: string;
};

export type FileFetchRequest = {
  path: string;
  upload_url: string;
};

export type FileFetchResponse = {
  blob_id: string;
  file_ref: string;
  mime: string;
  size: number;
};

export type DirListRequest = {
  path: string;
};

export type DirListEntry = {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime?: string;
};

export type DirListResponse = {
  entries: DirListEntry[];
};

export type FilePushRequest = {
  url?: string;
  local_source?: string;
  target_path: string;
};

export type FilePushResponse = {
  size: number;
};

export type FsProbeMarker = {
  path: string;
  nonce: string;
};

export type FsProbeRequest = {
  path: string;
};

export type FsProbeResponse = {
  content: string;
  found: boolean;
};

// ─── Incremental capability update ────────────────────────────────────────────

export type EndpointUpdateParams = {
  register?: {
    tools?: ToolCapability[];
    mcpTools?: ToolCapability[];
    skills?: SkillMeta[];
    instructions?: string;
  };
  unregister?: {
    tools?: boolean;
    mcpTools?: boolean;
    skills?: boolean;
  };
};

// ─── Tool handler ─────────────────────────────────────────────────────────────

export type ToolHandler = (args: Record<string, unknown>) => Promise<ContentPart[] | unknown>;

// ─── Local persistence ────────────────────────────────────────────────────────

export interface EndpointStorage {
  getData(key: string): Promise<string | null>;
  setData(key: string, value: string): Promise<void>;
  deleteData(key: string): Promise<void>;
}
