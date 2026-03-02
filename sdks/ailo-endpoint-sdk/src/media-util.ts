/**
 * media-util.ts — MIME 推断与媒体类型分类。
 *
 * 所有端点共用，消除各包重复的 MIME / mediaType 逻辑。
 */

import * as path from "path";

const MIME_MAP: Record<string, string> = {
  // image
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  wma: "audio/x-ms-wma",
  // video
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  m4v: "video/mp4",
  // document
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // text / data
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
  yaml: "text/yaml",
  yml: "text/yaml",
  // archive
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
};

/** 根据文件路径的扩展名推断 MIME 类型。 */
export function inferMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** 根据 MIME 类型分类为 ContentPart.type 枚举值。 */
export function classifyMedia(mime: string): "image" | "audio" | "video" | "pdf" | "file" {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  return "file";
}
