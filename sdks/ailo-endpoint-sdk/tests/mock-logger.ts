import { vi } from "vitest";
import type { Logger } from "../src/logger.js";
import { LogLevelValue } from "../src/logger.js";

/** Minimal `Logger` for unit tests (all methods are `vi.fn()`). */
export function createMockLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => LogLevelValue.INFO),
  };
}
