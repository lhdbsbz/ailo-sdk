import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

export interface EnvMapping {
  envVar: string;
  configPath: string;
}

export function readConfig<T = Record<string, unknown>>(configPath: string): Partial<T> {
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return {} as Partial<T>;
  }
}

export function writeConfig<T = Record<string, unknown>>(configPath: string, data: T): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.config-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, configPath);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Merge config.json values with environment variables.
 * Priority: env > config.json.
 * Returns a new object; original is not mutated.
 * Also returns which fields were overridden by env (for UI display).
 */
export function mergeWithEnv<T = Record<string, unknown>>(
  config: Partial<T>,
  mapping: EnvMapping[],
): { merged: T; envOverrides: Set<string> } {
  const result = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const envOverrides = new Set<string>();
  for (const { envVar, configPath } of mapping) {
    const envVal = process.env[envVar];
    if (envVal !== undefined && envVal !== "") {
      setNestedValue(result, configPath, envVal);
      envOverrides.add(configPath);
    }
  }
  return { merged: result as T, envOverrides };
}

export { getNestedValue, setNestedValue };
