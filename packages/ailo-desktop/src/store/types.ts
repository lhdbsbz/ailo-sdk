import type { ToolCapability } from "@greatlhd/ailo-endpoint-sdk";
import type { MCPServerConfig } from "../mcp/config-manager.js";

export type MCPServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface MCPServerState {
  name: string;
  status: MCPServiceStatus;
  tools: ToolCapability[];
  config: MCPServerConfig;
}

export interface MCPState {
  servers: Map<string, MCPServerState>;
  tools: ToolCapability[];
}

export interface AiloState {
  connected: boolean;
  endpointId: string;
  tools: ToolCapability[];
}

export interface AppState {
  ailo: AiloState;
  mcp: MCPState;
}
