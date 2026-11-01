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

