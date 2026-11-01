import { readConfig } from "./config-io.js";

export interface AiloConnectionConfig {
  url: string;
  apiKey: string;
  bodyId: string;
}

/**
 * Reads `config.json` (or any JSON file) and builds connection fields:
 * env `AILO_WS_URL` / `AILO_API_KEY` / `AILO_BODY_ID` override the `ailo` block
 * (`wsUrl`, `apiKey`, `bodyId`).
 */
export function loadConnectionConfig(configPath: string): AiloConnectionConfig {
  const raw = readConfig(configPath);
  const ailo = (raw as Record<string, unknown>).ailo as Record<string, unknown> | undefined;
  return {
    url: process.env.AILO_WS_URL || (ailo?.wsUrl as string) || "",
    apiKey: process.env.AILO_API_KEY || (ailo?.apiKey as string) || "",
    bodyId: process.env.AILO_BODY_ID || (ailo?.bodyId as string) || "",
  };
}

export function hasValidConfig(c: AiloConnectionConfig): boolean {
  return !!(c.url && c.apiKey && c.bodyId);
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
