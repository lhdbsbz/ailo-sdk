import type { ContentPart } from "./types.js";
import { autoUploadMedia, materializeInlineMedia } from "./media-middleware.js";
import { inferMime } from "./media-util.js";
import * as path from "path";
import type { BlobClient } from "./blob-client.js";
import { isRecord, isContentParts, stringifyValue } from "./content-parts.js";

function isContentPartType(value: unknown): value is ContentPart["type"] {
  return value === "text" || value === "image" || value === "audio" ||
    value === "video" || value === "pdf" || value === "file";
}

function isMcpCallResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (
    Array.isArray(value.content) ||
    "structuredContent" in value ||
    "isError" in value
  );
}

function mcpItemToContentPart(item: unknown): ContentPart {
  if (!isRecord(item)) {
    return { type: "text", text: stringifyValue(item) };
  }

  const rawType = item.type;
  if (!isContentPartType(rawType)) {
    return { type: "text", text: stringifyValue(item) };
  }
  if (rawType === "text") {
    return { type: "text", text: stringifyValue(item.text ?? "") };
  }

  const mediaSource = isRecord(item.media) ? item.media : item;
  const media: Record<string, unknown> = { type: rawType };
  if (typeof mediaSource.fileRef === "string") media.fileRef = mediaSource.fileRef;
  if (typeof mediaSource.path === "string") media.path = mediaSource.path;
  if (typeof mediaSource.url === "string") media.url = mediaSource.url;
  if (typeof mediaSource.sourcePath === "string") media.sourcePath = mediaSource.sourcePath;

  const mime =
    typeof mediaSource.mime === "string"
      ? mediaSource.mime
      : typeof mediaSource.mimeType === "string"
        ? mediaSource.mimeType
        : "";
  if (mime) media.mime = mime;
  if (typeof mediaSource.name === "string") media.name = mediaSource.name;

  if (!media.path && !media.url && !media.fileRef && typeof mediaSource.data === "string") {
    const localPath = materializeInlineMedia(mediaSource.data, mime || undefined, rawType);
    media.path = localPath;
    media.mime = mime || inferMime(localPath);
    media.name = typeof media.name === "string" && media.name
      ? media.name
      : path.basename(localPath);
  }

  if (!media.path && !media.url && !media.fileRef) {
    return { type: "text", text: stringifyValue(item) };
  }
  if (!media.mime && typeof media.path === "string") media.mime = inferMime(media.path);
  if (!media.name && typeof media.path === "string") media.name = path.basename(media.path);

  return { type: rawType, media: media as ContentPart["media"] };
}

function adaptMcpCallResult(result: Record<string, unknown>): ContentPart[] {
  const parts: ContentPart[] = [];
  if (Array.isArray(result.content)) {
    result.content.forEach((item) => parts.push(mcpItemToContentPart(item)));
  }
  if ("structuredContent" in result && result.structuredContent !== undefined) {
    parts.push({ type: "text", text: stringifyValue(result.structuredContent) });
  }
  return parts;
}

function extractMcpError(result: Record<string, unknown>): string {
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return stringifyValue(result.structuredContent);
  }
  return "MCP tool call failed";
}

export async function normalizeToolResult(
  result: unknown,
  blobClient: BlobClient,
): Promise<ContentPart[] | unknown> {
  if (isContentParts(result)) {
    await autoUploadMedia(result, blobClient);
    return result;
  }
  if (isMcpCallResult(result)) {
    if (result.isError === true) {
      throw new Error(extractMcpError(result));
    }
    const adapted = adaptMcpCallResult(result);
    await autoUploadMedia(adapted, blobClient);
    return adapted;
  }
  return result;
}
