export interface AiloConnectionConfig {
  url: string;
  apiKey: string;
  endpointId: string;
  displayName?: string;
}

export function hasValidConfig(c: AiloConnectionConfig): boolean {
  return !!(c.url && c.apiKey && c.endpointId);
}

/**
 * Exponential backoff delay with optional jitter.
 * @param attempt 0-based attempt count
 */
export function backoffDelayMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 60_000,
  jitter = true,
): number {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs);
  if (!jitter) return raw;
  const spread = raw * 0.1 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(raw + spread));
}

/** Standard env mapping for the common ailo connection fields. */
export const AILO_ENV_MAPPING = [
  { envVar: "AILO_WS_URL", configPath: "ailo.wsUrl" },
  { envVar: "AILO_API_KEY", configPath: "ailo.apiKey" },
  { envVar: "AILO_ENDPOINT_ID", configPath: "ailo.endpointId" },
  { envVar: "DISPLAY_NAME", configPath: "ailo.displayName" },
];
