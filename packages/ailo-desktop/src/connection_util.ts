/**
 * Re-exports from SDK + config.json loading helper for desktop.
 */

export {
  hasValidConfig,
  backoffDelayMs,
  AILO_ENV_MAPPING,
  readConfig,
  mergeWithEnv,
} from "@lmcl/ailo-endpoint-sdk";
export type { AiloConnectionConfig } from "@lmcl/ailo-endpoint-sdk";

import { readConfig, mergeWithEnv, AILO_ENV_MAPPING } from "@lmcl/ailo-endpoint-sdk";
import type { AiloConnectionConfig } from "@lmcl/ailo-endpoint-sdk";

export function loadConnectionConfig(configPath: string): AiloConnectionConfig {
  const raw = readConfig(configPath);
  const { merged } = mergeWithEnv(raw, AILO_ENV_MAPPING);
  const ailo = (merged as Record<string, unknown>).ailo as Record<string, unknown> | undefined;
  return {
    url: (ailo?.wsUrl as string) ?? "",
    apiKey: (ailo?.apiKey as string) ?? "",
    endpointId: (ailo?.endpointId as string) ?? "",
  };
}
