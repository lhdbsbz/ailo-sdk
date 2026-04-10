import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/endpoint-client-fs.js", () => ({
  handleEndpointFileFetch: vi.fn(),
  handleEndpointDirList: vi.fn(),
  handleEndpointFilePush: vi.fn(),
  handleEndpointFsProbe: vi.fn(),
}));

import { dispatchEndpointEvent, type WsFrame } from "../src/endpoint-client-events.js";
import * as endpointFs from "../src/endpoint-client-fs.js";
import { createMockLogger } from "./mock-logger.js";

function baseDeps(over: Partial<Parameters<typeof dispatchEndpointEvent>[1]> = {}) {
  return {
    toolRequestHandler: null,
    intentHandler: null,
    worldEnrichmentHandler: null,
    streamHandler: null,
    sendToolResponse: vi.fn().mockResolvedValue(undefined),
    logger: createMockLogger(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchEndpointEvent", () => {
  it("invokes intentHandler for intent", () => {
    const intentHandler = vi.fn();
    const frame: WsFrame = { type: "event", event: "intent", payload: { x: 1 } };
    dispatchEndpointEvent(frame, baseDeps({ intentHandler }));
    expect(intentHandler).toHaveBeenCalledTimes(1);
    expect(intentHandler.mock.calls[0][0]).toEqual({ x: 1 });
  });

  it("invokes streamHandler for stream", () => {
    const streamHandler = vi.fn();
    const frame: WsFrame = { type: "event", event: "stream", payload: { chunk: "a" } };
    dispatchEndpointEvent(frame, baseDeps({ streamHandler }));
    expect(streamHandler).toHaveBeenCalledWith({ chunk: "a" });
  });

  it("invokes worldEnrichmentHandler for world_enrichment", () => {
    const worldEnrichmentHandler = vi.fn();
    const frame: WsFrame = { type: "event", event: "world_enrichment", payload: {} };
    dispatchEndpointEvent(frame, baseDeps({ worldEnrichmentHandler }));
    expect(worldEnrichmentHandler).toHaveBeenCalledTimes(1);
  });

  it("tool_request: sends success content from handler result", async () => {
    const sendToolResponse = vi.fn().mockResolvedValue(undefined);
    const toolRequestHandler = vi.fn().mockResolvedValue([{ type: "text", text: "ok" }]);
    const frame: WsFrame = {
      type: "event",
      event: "tool_request",
      payload: { id: "t1", name: "n", args: {} },
    };
    dispatchEndpointEvent(frame, baseDeps({ toolRequestHandler, sendToolResponse }));
    await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalled());
    expect(sendToolResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t1",
        success: true,
        content: [{ type: "text", text: "ok" }],
      }),
    );
  });

  it("tool_request: sends error when handler throws", async () => {
    const sendToolResponse = vi.fn().mockResolvedValue(undefined);
    const toolRequestHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const frame: WsFrame = {
      type: "event",
      event: "tool_request",
      payload: { id: "t2", name: "n", args: {} },
    };
    dispatchEndpointEvent(frame, baseDeps({ toolRequestHandler, sendToolResponse }));
    await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalled());
    expect(sendToolResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t2",
        success: false,
        error: "boom",
      }),
    );
  });

  it("tool_request: no-op without handler", () => {
    const sendToolResponse = vi.fn();
    const frame: WsFrame = {
      type: "event",
      event: "tool_request",
      payload: { id: "t3", name: "n", args: {} },
    };
    dispatchEndpointEvent(frame, baseDeps({ toolRequestHandler: null, sendToolResponse }));
    expect(sendToolResponse).not.toHaveBeenCalled();
  });

  it("forwards file_fetch to handleEndpointFileFetch", () => {
    const payload = { path: "/x", upload_url: "http://u" };
    const frame: WsFrame = {
      type: "event",
      id: "req-1",
      event: "file_fetch",
      payload,
    };
    dispatchEndpointEvent(frame, baseDeps());
    expect(endpointFs.handleEndpointFileFetch).toHaveBeenCalledWith(
      "req-1",
      payload,
      expect.any(Function),
      expect.any(Object),
    );
  });

  it("unknown event is ignored", () => {
    const sendToolResponse = vi.fn();
    const frame: WsFrame = { type: "event", event: "unknown_future", payload: {} };
    dispatchEndpointEvent(frame, baseDeps({ sendToolResponse }));
    expect(sendToolResponse).not.toHaveBeenCalled();
  });
});
