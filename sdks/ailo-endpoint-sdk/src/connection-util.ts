import { createInterface } from "readline";
import { readConfig } from "./config-io.js";

export interface AiloConnectionConfig {
  url: string;
  apiKey: string;
  endpointId: string;
}

/**
 * Reads `config.json` (or any JSON file) and builds connection fields:
 * env `AILO_WS_URL` / `AILO_API_KEY` / `AILO_ENDPOINT_ID` override the `ailo` block
 * (`wsUrl`, `apiKey`, `endpointId`).
 */
export function loadConnectionConfig(configPath: string): AiloConnectionConfig {
  const raw = readConfig(configPath);
  const ailo = (raw as Record<string, unknown>).ailo as Record<string, unknown> | undefined;
  return {
    url: process.env.AILO_WS_URL || (ailo?.wsUrl as string) || "",
    apiKey: process.env.AILO_API_KEY || (ailo?.apiKey as string) || "",
    endpointId: process.env.AILO_ENDPOINT_ID || (ailo?.endpointId as string) || "",
  };
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

const DEFAULT_INVALID_MSG = "无效端口，请输入 1-65535 之间的数字";

export interface PromptTCPPortOptions {
  question: string;
  /** Called when the line is not a valid TCP port; defaults to `console.error`. */
  onInvalid?: (message: string) => void;
}

/** Prompts until the user enters a valid TCP port (1–65535). */
export async function promptTCPPort(options: PromptTCPPortOptions): Promise<number> {
  const onInvalid = options.onInvalid ?? ((m: string) => console.error(m));
  for (;;) {
    const n = await new Promise<number | null>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(options.question, (answer) => {
        rl.close();
        const x = Number(answer.trim());
        resolve(!Number.isNaN(x) && x > 0 && x < 65536 ? x : null);
      });
    });
    if (n !== null) return n;
    onInvalid(DEFAULT_INVALID_MSG);
  }
}
