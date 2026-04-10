import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  writeFsProbeFile,
  unlinkFsProbeFile,
  handleEndpointFileFetch,
  handleEndpointDirList,
  handleEndpointFilePush,
  handleEndpointFsProbe,
} from "../src/endpoint-client-fs.js";
import { createMockLogger } from "./mock-logger.js";

describe("endpoint-client-fs", () => {
  describe("writeFsProbeFile / unlinkFsProbeFile", () => {
    it("writes nonce file under tmpdir and unlink removes it", () => {
      const logger = createMockLogger();
      const marker = writeFsProbeFile("vitest-probe-ep", logger);
      expect(marker).not.toBeNull();
      expect(marker!.nonce.length).toBeGreaterThan(0);
      expect(fs.existsSync(marker!.path)).toBe(true);
      unlinkFsProbeFile(marker!.path);
      expect(fs.existsSync(marker!.path)).toBe(false);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("path validation (no disk / network)", () => {
    it("handleEndpointFileFetch rejects non-absolute path", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const logger = createMockLogger();
      await handleEndpointFileFetch(
        "id1",
        { path: "relative/file.txt", upload_url: "http://example/upload" },
        send,
        logger,
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "id1",
          success: false,
          error: expect.stringContaining("absolute"),
        }),
      );
    });

    it("handleEndpointDirList rejects non-absolute path", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      await handleEndpointDirList("id2", { path: "rel" }, send, createMockLogger());
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining("absolute"),
        }),
      );
    });

    it("handleEndpointFilePush rejects non-absolute target_path", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      await handleEndpointFilePush(
        "id3",
        { target_path: "rel/out" },
        send,
        createMockLogger(),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining("target_path must be absolute"),
        }),
      );
    });

    it("handleEndpointFilePush rejects missing url and local_source", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const abs = path.join(os.tmpdir(), `ailo-fs-test-${Date.now()}.txt`);
      await handleEndpointFilePush("id4", { target_path: abs }, send, createMockLogger());
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "neither url nor local_source provided",
        }),
      );
    });

    it("handleEndpointFsProbe non-absolute path returns found false", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      await handleEndpointFsProbe("id5", { path: "not/abs" }, send, createMockLogger());
      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0][0];
      expect(call.success).toBe(true);
      expect(call.content?.[0]?.type).toBe("text");
      expect((call.content![0] as { text: string }).text).toContain('"found":false');
    });
  });
});
