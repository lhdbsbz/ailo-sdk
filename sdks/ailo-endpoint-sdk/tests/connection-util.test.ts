import { describe, it, expect } from "vitest";
import {
  hasValidConfig,
  backoffDelayMs,
  type AiloConnectionConfig,
} from "../src/connection-util.js";

describe("connection-util", () => {
  it("hasValidConfig requires all three fields", () => {
    const full: AiloConnectionConfig = {
      url: "ws://x/ws",
      apiKey: "k",
      endpointId: "e",
    };
    expect(hasValidConfig(full)).toBe(true);
    expect(hasValidConfig({ ...full, url: "" })).toBe(false);
    expect(hasValidConfig({ ...full, apiKey: "" })).toBe(false);
    expect(hasValidConfig({ ...full, endpointId: "" })).toBe(false);
  });

  it("backoffDelayMs without jitter is deterministic and capped", () => {
    expect(backoffDelayMs(0, 1000, 60_000, false)).toBe(1000);
    expect(backoffDelayMs(10, 1000, 60_000, false)).toBe(60_000);
  });

  it("backoffDelayMs with jitter stays within a reasonable floor", () => {
    for (let i = 0; i < 20; i++) {
      const d = backoffDelayMs(2, 1000, 60_000, true);
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });
});
