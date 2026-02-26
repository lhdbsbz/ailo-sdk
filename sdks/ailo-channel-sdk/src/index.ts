import "@lmcl/ailo-mcp-sdk/stdio-guard";

export { getWorkDir, runMcp } from "@lmcl/ailo-mcp-sdk";
export { AiloClient, tagValue } from "./ailo-client.js";
export type { AiloClientConfig, ChannelHealthStatus } from "./ailo-client.js";
export { runMcpChannel, defaultChannelInstructions } from "./bootstrap.js";
export type { McpChannelConfig } from "./bootstrap.js";
export { textPart, mediaPart } from "./types.js";
export type {
  ChannelContext,
  ChannelHandler,
  ChannelMessage,
  ChannelStorage,
  ContentPart,
  ContextTag,
  MediaData,
} from "./types.js";
