import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import type { ContentPart } from "./types.js";
import { inferMime } from "./media-util.js";
import { parseFileRef, isFileRef } from "./fileref.js";
import type { BlobClient } from "./blob-client.js";

export async function autoUploadMedia(
  content: ContentPart[],
  blobClient: BlobClient,
): Promise<void> {
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (!part.media?.path) continue;

    const absPath = path.resolve(part.media.path);
    if (!fs.existsSync(absPath)) {
      throw new Error(`auto-upload: file not found: ${absPath}`);
    }

    const { fileRef } = await blobClient.upload(absPath);
    content[i] = {
      ...part,
      media: {
        type: part.media.type,
        fileRef,
        mime: part.media.mime || inferMime(absPath),
        name: part.media.name || path.basename(absPath),
        sourcePath: absPath,
      },
    };
  }
}

export async function resolveFileArgsInPlace(
  args: Record<string, unknown>,
  blobClient: BlobClient,
  blobUrlPrefix: string,
): Promise<void> {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.startsWith(blobUrlPrefix)) {
      try {
        args[key] = await blobClient.download(value);
      } catch {
        // keep original
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === "string" && (value[i] as string).startsWith(blobUrlPrefix)) {
          try {
            value[i] = await blobClient.download(value[i] as string);
          } catch {
            // keep
          }
        } else if (typeof value[i] === "object" && value[i] !== null) {
          await resolveFileArgsInPlace(value[i] as Record<string, unknown>, blobClient, blobUrlPrefix);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      await resolveFileArgsInPlace(value as Record<string, unknown>, blobClient, blobUrlPrefix);
    }
  }
}

export async function resolveToLocal(
  pathOrUrl: string,
  blobClient: BlobClient,
  endpointId: string,
  blobUrlPrefix: string,
): Promise<string> {
  if (isFileRef(pathOrUrl)) {
    const parsed = parseFileRef(pathOrUrl);
    if (parsed.type === "endpoint" && parsed.endpointId === endpointId) {
      return parsed.path!;
    }
    if (parsed.type === "blob") {
      return blobClient.download(`${blobClient["opts"].httpBase}/api/blob/${parsed.blobId}`);
    }
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith(blobUrlPrefix)) {
    return blobClient.download(pathOrUrl);
  }
  return pathOrUrl;
}

function tmpExtensionForMedia(mime: string | undefined, type: Exclude<ContentPart["type"], "text">): string {
  const normalized = (mime || "").toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return ".wav";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "application/pdf") return ".pdf";
  if (type === "image") return ".png";
  if (type === "audio") return ".mp3";
  if (type === "video") return ".mp4";
  if (type === "pdf") return ".pdf";
  return ".bin";
}

export function materializeInlineMedia(
  data: string,
  mime: string | undefined,
  type: Exclude<ContentPart["type"], "text">,
): string {
  const dir = path.join(os.tmpdir(), "ailo_mcp_media");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `${Date.now()}_${crypto.randomUUID()}${tmpExtensionForMedia(mime, type)}`,
  );
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  return filePath;
}
