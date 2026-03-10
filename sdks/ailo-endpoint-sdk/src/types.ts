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
  error?: string;
  /** Unified response format. Structured payloads should be encoded as JSON text in a single text part. */
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

/** Received via stream event — carries live text chunks from the server */
export type StreamPayload = {
  streamId: string;
  action: "start" | "chunk" | "end";
  text?: string;           // present when action="chunk"
  correlationId?: string;  // links to the accept/world_update that triggered the stream
};

/** Received via file_fetch request — server asks endpoint to upload a local file */
export type FileFetchRequest = {
  path: string;             // local path on the endpoint
  upload_url: string;       // Blob API upload URL
};

/** Response to file_fetch — endpoint returns after uploading */
export type FileFetchResponse = {
  blob_id: string;
  file_ref: string;
  mime: string;
  size: number;
};

/** Received via dir_list request — server asks endpoint to list a local directory */
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

/** Received via file_push request — server asks endpoint to download a file and save locally.
 *  When local_source is present, the file is on the same filesystem — do a local copy instead of download. */
export type FilePushRequest = {
  url?: string;
  local_source?: string;
  target_path: string;
};

export type FilePushResponse = {
  size: number;
};

/** Filesystem probe marker — written on connect, used to detect co-located endpoints */
export type FsProbeMarker = {
  path: string;
  nonce: string;
};

/** Received via fs_probe request — server asks endpoint to read a probe file */
export type FsProbeRequest = {
  path: string;
};

export type FsProbeResponse = {
  content: string;
  found: boolean;
};

// ─── Incremental capability update ────────────────────────────────────────────

/** Parameters for endpoint.update — incremental register/unregister of capabilities */
export type EndpointUpdateParams = {
  register?: {
    tools?: ToolCapability[];
    blueprints?: string[];
    skills?: SkillMeta[];
    caps?: string[];
    instructions?: string;
  };
  unregister?: {
    tools?: string[];
    blueprints?: string[];
    skills?: string[];
    caps?: string[];
  };
};

// ─── Tool handler ─────────────────────────────────────────────────────────────

/** Tool handler return type: ContentPart[] for direct multimodal results; any other value is serialized into a text ContentPart. */
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
  return null;
}
