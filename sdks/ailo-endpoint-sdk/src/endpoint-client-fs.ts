import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type {
  ContentPart,
  DirListRequest,
  FileFetchRequest,
  FilePushRequest,
  FsProbeMarker,
  FsProbeRequest,
  ToolResponsePayload,
} from "./types.js";
import type { Logger } from "./logger.js";

function jsonTextContent(value: unknown): ContentPart[] {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error("structured payload must be JSON-serializable");
  }
  return [{ type: "text", text }];
}

export function writeFsProbeFile(endpointId: string, logger: Logger): FsProbeMarker | null {
  try {
    const nonce = crypto.randomUUID();
    const probePath = path.join(os.tmpdir(), `ailo-ep-${endpointId}.probe`);
    fs.writeFileSync(probePath, nonce, "utf-8");
    return { path: probePath, nonce };
  } catch (err) {
    logger.error("fs_probe_write_failed", { error: String(err) });
    return null;
  }
}

export function unlinkFsProbeFile(probePath: string): void {
  try {
    fs.unlinkSync(probePath);
  } catch {
    /* ignore */
  }
}

export async function handleEndpointFileFetch(
  reqId: string,
  payload: FileFetchRequest,
  send: (p: ToolResponsePayload) => Promise<void>,
  logger: Logger,
): Promise<void> {
  try {
    const localPath = payload.path;
    if (!path.isAbsolute(localPath)) {
      await send({ id: reqId, success: false, error: `path must be absolute, got: "${localPath}"` });
      return;
    }
    if (!fs.existsSync(localPath)) {
      await send({ id: reqId, success: false, error: `file not found: ${localPath}` });
      return;
    }
    const fileBuffer = fs.readFileSync(localPath);
    const fileName = path.basename(localPath);

    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), fileName);

    const res = await fetch(payload.upload_url, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      await send({ id: reqId, success: false, error: `upload failed: ${res.status}` });
      return;
    }
    const result = (await res.json()) as Record<string, unknown>;
    await send({ id: reqId, success: true, content: jsonTextContent(result) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("file_fetch_error", { error: msg });
    await send({ id: reqId, success: false, error: msg }).catch(() => {});
  }
}

export async function handleEndpointDirList(
  reqId: string,
  payload: DirListRequest,
  send: (p: ToolResponsePayload) => Promise<void>,
  logger: Logger,
): Promise<void> {
  try {
    const dirPath = payload.path;
    if (!path.isAbsolute(dirPath)) {
      await send({ id: reqId, success: false, error: `path must be absolute, got: "${dirPath}"` });
      return;
    }
    if (!fs.existsSync(dirPath)) {
      await send({ id: reqId, success: false, error: `directory not found: ${dirPath}` });
      return;
    }
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      await send({ id: reqId, success: false, error: `not a directory: ${dirPath}` });
      return;
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = {
      entries: entries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => {
          const fullPath = path.join(dirPath, e.name);
          try {
            const s = fs.statSync(fullPath);
            return {
              name: e.name,
              type: e.isDirectory() ? "dir" : "file",
              size: s.size,
              mtime: s.mtime.toISOString(),
            };
          } catch {
            return { name: e.name, type: e.isDirectory() ? "dir" : "file", size: 0 };
          }
        }),
    };
    await send({ id: reqId, success: true, content: jsonTextContent(result) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("dir_list_error", { error: msg });
    await send({ id: reqId, success: false, error: msg }).catch(() => {});
  }
}

export async function handleEndpointFilePush(
  reqId: string,
  payload: FilePushRequest,
  send: (p: ToolResponsePayload) => Promise<void>,
  logger: Logger,
): Promise<void> {
  try {
    const targetPath = payload.target_path;
    if (!path.isAbsolute(targetPath)) {
      await send({ id: reqId, success: false, error: `target_path must be absolute, got: "${targetPath}"` });
      return;
    }
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });

    if (payload.local_source) {
      if (!path.isAbsolute(payload.local_source)) {
        await send({ id: reqId, success: false, error: `local_source must be absolute, got: "${payload.local_source}"` });
        return;
      }
      fs.copyFileSync(payload.local_source, targetPath);
      const stat = fs.statSync(targetPath);
      await send({ id: reqId, success: true, content: jsonTextContent({ size: stat.size }) });
      return;
    }

    if (!payload.url) {
      await send({ id: reqId, success: false, error: "neither url nor local_source provided" });
      return;
    }
    const res = await fetch(payload.url);
    if (!res.ok) {
      await send({ id: reqId, success: false, error: `download failed: ${res.status}` });
      return;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(targetPath, buffer);
    await send({ id: reqId, success: true, content: jsonTextContent({ size: buffer.length }) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("file_push_error", { error: msg });
    await send({ id: reqId, success: false, error: msg }).catch(() => {});
  }
}

export async function handleEndpointFsProbe(
  reqId: string,
  payload: FsProbeRequest,
  send: (p: ToolResponsePayload) => Promise<void>,
  logger: Logger,
): Promise<void> {
  try {
    if (!path.isAbsolute(payload.path)) {
      await send({ id: reqId, success: true, content: jsonTextContent({ found: false, content: "" }) });
      return;
    }
    if (fs.existsSync(payload.path)) {
      const content = fs.readFileSync(payload.path, "utf-8");
      await send({ id: reqId, success: true, content: jsonTextContent({ found: true, content }) });
    } else {
      await send({ id: reqId, success: true, content: jsonTextContent({ found: false, content: "" }) });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await send({ id: reqId, success: true, content: jsonTextContent({ found: false, content: "" }) }).catch(() => {});
    logger.error("fs_probe_error", { error: msg });
  }
}
