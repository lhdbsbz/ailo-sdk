export {
  hasValidConfig,
  backoffDelayMs,
  readConfig,
  writeConfig,
  getNestedValue,
  setNestedValue,
} from "@lmcl/ailo-endpoint-sdk";
export type { AiloConnectionConfig } from "@lmcl/ailo-endpoint-sdk";

import { readConfig } from "@lmcl/ailo-endpoint-sdk";
import type { AiloConnectionConfig } from "@lmcl/ailo-endpoint-sdk";

export function loadConnectionConfig(configPath: string): AiloConnectionConfig {
  const raw = readConfig(configPath);
  const ailo = (raw as Record<string, unknown>).ailo as Record<string, unknown> | undefined;
  return {
    url: (ailo?.wsUrl as string) ?? "",
    apiKey: (ailo?.apiKey as string) ?? "",
    endpointId: (ailo?.endpointId as string) ?? "",
  };
}
