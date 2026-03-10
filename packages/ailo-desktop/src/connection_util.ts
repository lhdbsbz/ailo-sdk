/**
 * Re-exports from SDK + config.json loading helper for desktop.
 */

export {
  hasValidConfig,
  backoffDelayMs,
  readConfig,
} from "@lmcl/ailo-endpoint-sdk";
export type { AiloConnectionConfig } from "@lmcl/ailo-endpoint-sdk";

import { readConfig } from "@lmcl/ailo-endpoint-sdk";
import type { AiloConnectionConfig } from "@lmcl/ailo-endpoint-sdk";

export function loadConnectionConfig(configPath: string): AiloConnectionConfig {
  const raw = readConfig(configPath);
  const ailo = (raw as Record<string, unknown>).ailo as Record<string, unknown> | undefined;
  return {
    url: process.env.AILO_WS_URL || (ailo?.wsUrl as string) || "",
    apiKey: process.env.AILO_API_KEY || (ailo?.apiKey as string) || "",
    endpointId: process.env.AILO_ENDPOINT_ID || (ailo?.endpointId as string) || "",
  };
}
