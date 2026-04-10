import * as fs from "fs";
import * as path from "path";
import type { ContentPart } from "@greatlhd/ailo-endpoint-sdk";
import { validateArgs } from "./param_validator.js";
import { requireAbsPath } from "./path_utils.js";
import { markFileRead, isFileStale, clearFileState } from "./tool_context.js";
import { applyPatchFromArgs } from "./apply_patch.js";

type Args = Record<string, unknown>;

export async function fsTool(name: string, args: Args): Promise<string | ContentPart[]> {
  switch (name) {
    case "read":
      return readFile(args);
    case "write":
      return writeFile(args);
    case "edit":
      return editFile(args);
    case "apply_patch":
      return applyPatchFromArgs(args);
    default:
      throw new Error(`unknown fs tool: ${name}`);
  }
}

interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function inferMime(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}

async function readFile(args: Args): Promise<string | ContentPart[]> {
  const validated = validateArgs<ReadFileArgs>(args, {
    path: { type: "string", required: true },
    offset: { type: "number", default: 1, min: 1 },
    limit: { type: "number", default: 1000, min: 1 },
  });
  const filePath = requireAbsPath(validated.path, "path");
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`路径不是文件: ${filePath}`);

  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (IMAGE_EXTENSIONS.has(ext)) {
    const mime = inferMime(ext);
    return [
      {
        type: "image",
        media: {
          type: "image",
          path: filePath,
          mime,
          name: path.basename(filePath),
        },
      },
    ];
  }

  const offset = validated.offset! - 1;
  const limit = validated.limit!;

  const rawBuf = fs.readFileSync(filePath);
  const detected = detectEncoding(rawBuf);
  const textContent = detected.bom
    ? rawBuf.slice(detected.bom.length).toString("utf8")
    : rawBuf.toString("utf8");
  const lines = textContent.split("\n");
  const totalLines = lines.length;
  const slice = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
  const startLineNum = offset + 1;
  const endLineNum = startLineNum + slice.length - 1;
  const isPartial = slice.length < totalLines;

  markFileRead(filePath, textContent, stat.mtime, validated.offset!, validated.limit!);

  const encodingInfo = detected.bom ? ` | Encoding: ${detected.encoding}+BOM` : "";
  const header = isPartial
    ? `[File: ${filePath} | Size: ${formatSize(stat.size)} | Lines: ${totalLines}${encodingInfo} | Showing: ${startLineNum}-${endLineNum} of ${totalLines}]`
    : `[File: ${filePath} | Size: ${formatSize(stat.size)} | Lines: ${totalLines}${encodingInfo}]`;

  const body = slice.map((line, i) => `${String(startLineNum + i).padStart(6)}|${line}`).join("\n");
  const content = header + "\n" + body;

  return JSON.stringify({
    ok: true,
    content,
    mtime: stat.mtimeMs,
  });
}

interface WriteFileArgs {
  path: string;
  content: string;
  encoding?: string;
}

const BOM_MAP: Record<string, Buffer> = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
  utf16le: Buffer.from([0xff, 0xfe]),
};

function detectEncoding(buf: Buffer): { encoding: string; bom: Buffer | null } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf-8", bom: buf.slice(0, 3) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf-16le", bom: buf.slice(0, 2) };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf-16be", bom: buf.slice(0, 2) };
  }
  return { encoding: "utf-8", bom: null };
}

function writeFile(args: Args): string {
  const validated = validateArgs<WriteFileArgs>(args, {
    path: { type: "string", required: true },
    content: { type: "string", required: true },
    encoding: { type: "string", default: "utf-8" },
  });
  const filePath = requireAbsPath(validated.path, "path");
  const content = validated.content;
  const encoding = validated.encoding || "utf-8";

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let oldBytes = 0;
  let bomPreserved = false;
  const created = !fs.existsSync(filePath);
  if (!created) {
    const oldBuf = fs.readFileSync(filePath);
    oldBytes = oldBuf.length;
    const detected = detectEncoding(oldBuf);
    const contentBuf = Buffer.from(content, "utf-8");
    const contentHasBom = Object.values(BOM_MAP).some(
      (bom) => contentBuf.length >= bom.length && contentBuf.slice(0, bom.length).equals(bom),
    );
    if (!contentHasBom && detected.bom) {
      const finalBuf = Buffer.concat([detected.bom, contentBuf]);
      fs.writeFileSync(filePath, finalBuf);
      bomPreserved = true;
    } else {
      fs.writeFileSync(filePath, content, encoding as BufferEncoding);
    }
  } else {
    fs.writeFileSync(filePath, content, encoding as BufferEncoding);
  }
  clearFileState(filePath);
  return JSON.stringify({
    ok: true,
    path: filePath,
    old_bytes: oldBytes,
    new_bytes: Buffer.byteLength(content, "utf-8"),
    encoding,
    bom_preserved: bomPreserved,
    created,
  });
}

interface EditFileArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function editFile(args: Args): string {
  const validated = validateArgs<EditFileArgs>(args, {
    path: { type: "string", required: true },
    old_string: { type: "string", required: true },
    new_string: { type: "string", required: true },
    replace_all: { type: "boolean", default: false },
  });
  const filePath = requireAbsPath(validated.path, "path");
  const oldStr = validated.old_string;
  const newStr = validated.new_string;
  const replaceAll = validated.replace_all ?? false;

  if (!fs.existsSync(filePath)) {
    return JSON.stringify({ ok: false, code: "file_not_found", error: `文件不存在: ${filePath}` });
  }

  if (isFileStale(filePath)) {
    return JSON.stringify({ ok: false, code: "file_stale", error: "文件未 read 或已被外部修改，请先 read 后再 edit" });
  }

  const content = fs.readFileSync(filePath, "utf-8");

  if (!content.includes(oldStr)) {
    return JSON.stringify({ ok: false, code: "parse_failed", error: "old_string 在文件中未找到" });
  }

  const escaped = escapeRegex(oldStr);
  const totalMatches = (content.match(new RegExp(escaped, "g")) || []).length;

  const originalContent = content;
  const oldLines = originalContent.split("\n");
  let newContent: string;
  let occurrences = 0;

  if (replaceAll) {
    occurrences = totalMatches;
    newContent = content.split(oldStr).join(newStr);
  } else {
    const idx = content.indexOf(oldStr);
    newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    occurrences = 1;
  }

  const newLines = newContent.split("\n");
  const additions = newLines.length - oldLines.length;
  const oldStrIdx = originalContent.indexOf(oldStr);
  const oldStrLineCount = oldStr.split("\n").length;
  const oldLineIdx = originalContent.slice(0, oldStrIdx).split("\n").length - 1;
  const lineStart = Math.max(0, oldLineIdx - 2);
  const lineEnd = Math.min(oldLines.length, oldLineIdx + oldStrLineCount + 2);

  fs.writeFileSync(filePath, newContent, "utf-8");

  const stat = fs.statSync(filePath);
  markFileRead(filePath, newContent, stat.mtime, 1, newLines.length);

  const result: Record<string, unknown> = {
    ok: true,
    path: filePath,
    occurrences,
    replace_all: replaceAll,
    hunk: {
      old_start: lineStart + 1,
      old_lines: lineEnd - lineStart,
      new_start: lineStart + 1,
      new_lines: lineEnd - lineStart + additions,
      lines: [
        ...oldLines.slice(lineStart, oldLineIdx).map((l) => ` ${l}`),
        ...oldStr.split("\n").map((l) => `-${l}`),
        ...newStr.split("\n").map((l) => `+${l}`),
        ...oldLines.slice(oldLineIdx + oldStrLineCount, lineEnd).map((l) => ` ${l}`),
      ],
    },
  };

  if (!replaceAll && totalMatches > 1) {
    result.warning = `old_string 在文件中出现 ${totalMatches} 次，仅替换第一次；如需全替换用 replace_all=true`;
  }

  return JSON.stringify(result);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
