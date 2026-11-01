import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

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

export { getNestedValue, setNestedValue };
