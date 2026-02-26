export { EndpointClient } from "./endpoint-client.js";
export type { EndpointClientConfig } from "./endpoint-client.js";
export type { ToolRequestHandler, IntentHandler, WorldEnrichmentHandler, StreamHandler, SignalHandler } from "./endpoint-client.js";

export { runEndpoint, runMcpEndpoint } from "./bootstrap.js";
export type { EndpointConfig, McpEndpointConfig, EndpointContext, EndpointHandler } from "./bootstrap.js";

export {
  textPart,
  mediaPart,
  getWorkDir,
  CAP_MESSAGE,
  CAP_WORLD_UPDATE,
  CAP_TOOL_EXECUTE,
  CAP_INTENT,
  CAP_SIGNAL,
} from "./types.js";

export type {
  MediaData,
  ContentPart,
  ContextTag,
  ToolCapability,
  ToolHandler,
  AcceptMessage,
  WorldUpdatePayload,
  ToolResponsePayload,
  WorldEnrichmentPayload,
  IntentPayload,
  ToolRequestPayload,
  StreamPayload,
  EndpointStorage,
  HealthStatus,
  Point2D,
  EntityPayload,
} from "./types.js";
