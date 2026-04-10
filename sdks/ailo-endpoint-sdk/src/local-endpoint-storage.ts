import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EndpointStorage } from "./types.js";

function safeEndpointDirSegment(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]+/g, "_").trim();
  return s.slice(0, 200) || "default";
}

function loadSync(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSync(filePath: string, data: Record<string, string>): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
  fs.renameSync(tmp, filePath);
}

export function createLocalEndpointStorage(endpointId: string): EndpointStorage {
  const dir = path.join(os.homedir(), ".ailo", "endpoint-data", safeEndpointDirSegment(endpointId));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "kv.json");

  let chain: Promise<void> = Promise.resolve();

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  return {
    getData(key: string): Promise<string | null> {
      return runExclusive(async () => {
        const o = loadSync(filePath);
        return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : null;
      });
    },
    async setData(key: string, value: string): Promise<void> {
      await runExclusive(async () => {
        const o = loadSync(filePath);
        o[key] = value;
        saveSync(filePath, o);
      });
    },
    async deleteData(key: string): Promise<void> {
      await runExclusive(async () => {
        const o = loadSync(filePath);
        delete o[key];
        saveSync(filePath, o);
      });
    },
  };
}

export interface CachedStorageOptions {
  flushDelayMs?: number;
  maxCacheSize?: number;
}

export function createCachedEndpointStorage(
  endpointId: string,
  options?: CachedStorageOptions,
): EndpointStorage & { flush(): Promise<void>; clearCache(): void } {
  const flushDelayMs = options?.flushDelayMs ?? 100;
  const maxCacheSize = options?.maxCacheSize ?? 1000;

  const dir = path.join(os.homedir(), ".ailo", "endpoint-data", safeEndpointDirSegment(endpointId));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "kv.json");

  const cache = new Map<string, string>();
  const dirtyKeys = new Set<string>();
  let loaded = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  function ensureLoaded(): void {
    if (loaded) return;
    const data = loadSync(filePath);
    for (const [k, v] of Object.entries(data)) {
      cache.set(k, v);
    }
    loaded = true;
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDelayMs);
  }

  async function flush(): Promise<void> {
    if (dirtyKeys.size === 0) return;

    const keysToFlush = [...dirtyKeys];
    dirtyKeys.clear();

    await writeChain;

    writeChain = (async () => {
      ensureLoaded();
      const data: Record<string, string> = {};
      for (const [k, v] of cache) {
        data[k] = v;
      }
      saveSync(filePath, data);
    })();
  }

  function clearCache(): void {
    cache.clear();
    dirtyKeys.clear();
    loaded = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  return {
    async getData(key: string): Promise<string | null> {
      ensureLoaded();
      return cache.has(key) ? cache.get(key)! : null;
    },

    async setData(key: string, value: string): Promise<void> {
      ensureLoaded();
      
      if (cache.size >= maxCacheSize && !cache.has(key)) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) {
          cache.delete(oldestKey);
          dirtyKeys.add(oldestKey);
        }
      }
      
      cache.set(key, value);
      dirtyKeys.add(key);
      scheduleFlush();
    },

    async deleteData(key: string): Promise<void> {
      ensureLoaded();
      cache.delete(key);
      dirtyKeys.add(key);
      scheduleFlush();
    },

    flush,
    clearCache,
  };
}
