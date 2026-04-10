/**
 * apply_patch：OpenClaw 风格 *** Begin Patch / *** End Patch 格式。
 * 逻辑改编自 openclaw/src/agents/apply-patch.ts，端点侧无 sandbox 桥接。
 */
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { ContentPart } from "@greatlhd/ailo-endpoint-sdk";
import { validateArgs } from "./param_validator.js";
import { requireAbsPath } from "./path_utils.js";
import { applyUpdateHunk } from "./apply_patch_update.js";
import { clearFileState } from "./tool_context.js";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

type AddFileHunk = { kind: "add"; path: string; contents: string };
type DeleteFileHunk = { kind: "delete"; path: string };
type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};
type UpdateFileHunk = {
  kind: "update";
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};
type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

interface ApplyPatchArgs {
  input: string;
}

/** 绝对路径直接使用；相对路径相对 cwd（默认进程当前目录）解析。无端点级「工作区根」限制。 */
function resolvePatchPath(filePath: string, cwd: string): string {
  const raw = filePath.trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  return requireAbsPath(resolved, "path");
}

function formatSummary(summary: ApplyPatchSummary): string {
  const lines = ["Success. Updated the following files:"];
  for (const file of summary.added) lines.push(`A ${file}`);
  for (const file of summary.modified) lines.push(`M ${file}`);
  for (const file of summary.deleted) lines.push(`D ${file}`);
  return lines.join("\n");
}

export async function applyPatchFromArgs(
  args: Record<string, unknown>,
  options?: { cwd?: string },
): Promise<ContentPart[]> {
  const validated = validateArgs<ApplyPatchArgs>(args, {
    input: { type: "string", required: true },
  });
  const input = validated.input.trim();
  if (!input) throw new Error("input 不能为空");

  const cwd = options?.cwd ?? process.cwd();

  const parsed = parsePatchText(input);
  if (parsed.hunks.length === 0) throw new Error("补丁未修改任何文件");

  const summary: ApplyPatchSummary = { added: [], modified: [], deleted: [] };
  const seen = { added: new Set<string>(), modified: new Set<string>(), deleted: new Set<string>() };

  for (const hunk of parsed.hunks) {
    if (hunk.kind === "add") {
      const target = resolvePatchPath(hunk.path, cwd);
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await fsPromises.writeFile(target, hunk.contents, "utf8");
      recordSummary(summary, seen, "added", path.relative(cwd, target) || target);
      clearFileState(target);
      continue;
    }
    if (hunk.kind === "delete") {
      const target = resolvePatchPath(hunk.path, cwd);
      await fsPromises.rm(target, { force: true });
      recordSummary(summary, seen, "deleted", path.relative(cwd, target) || target);
      continue;
    }

    const target = resolvePatchPath(hunk.path, cwd);
    const applied = await applyUpdateHunk(target, hunk.chunks, {
      readFile: (p) => fsPromises.readFile(p, "utf8"),
    });

    if (hunk.movePath) {
      const moveTarget = resolvePatchPath(hunk.movePath, cwd);
      await fsPromises.mkdir(path.dirname(moveTarget), { recursive: true });
      await fsPromises.writeFile(moveTarget, applied, "utf8");
      await fsPromises.rm(target, { force: true });
      recordSummary(summary, seen, "modified", path.relative(cwd, moveTarget) || moveTarget);
    } else {
      await fsPromises.writeFile(target, applied, "utf8");
      recordSummary(summary, seen, "modified", path.relative(cwd, target) || target);
    }
    clearFileState(target);
  }

  return [{ type: "text", text: formatSummary(summary) }];
}

function recordSummary(
  summary: ApplyPatchSummary,
  seen: { added: Set<string>; modified: Set<string>; deleted: Set<string> },
  bucket: keyof ApplyPatchSummary,
  value: string,
): void {
  if (seen[bucket].has(value)) return;
  seen[bucket].add(value);
  summary[bucket].push(value);
}

function parsePatchText(input: string): { hunks: Hunk[]; patch: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("补丁内容为空");

  const lines = trimmed.split(/\r?\n/);
  const validated = checkPatchBoundariesLenient(lines);
  const hunks: Hunk[] = [];

  const lastLineIndex = validated.length - 1;
  let remaining = validated.slice(1, lastLineIndex);
  let lineNumber = 2;

  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    remaining = remaining.slice(consumed);
  }

  return { hunks, patch: validated.join("\n") };
}

function checkPatchBoundariesLenient(lines: string[]): string[] {
  const strictError = checkPatchBoundariesStrict(lines);
  if (!strictError) return lines;

  if (lines.length < 4) throw new Error(strictError);

  const first = lines[0];
  const last = lines[lines.length - 1];
  if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith("EOF")) {
    const inner = lines.slice(1, lines.length - 1);
    const innerError = checkPatchBoundariesStrict(inner);
    if (!innerError) return inner;
    throw new Error(innerError);
  }

  throw new Error(strictError);
}

function checkPatchBoundariesStrict(lines: string[]): string | null {
  const firstLine = lines[0]?.trim();
  const lastLine = lines[lines.length - 1]?.trim();

  if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) {
    return null;
  }
  if (firstLine !== BEGIN_PATCH_MARKER) {
    return "补丁第一行必须是 '*** Begin Patch'";
  }
  return "补丁最后一行必须是 '*** End Patch'";
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; consumed: number } {
  if (lines.length === 0) {
    throw new Error(`无效补丁块（行 ${lineNumber}）：空块`);
  }
  const firstLine = lines[0].trim();
  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const targetPath = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let consumed = 1;
    for (const addLine of lines.slice(1)) {
      if (addLine.startsWith("+")) {
        contents += `${addLine.slice(1)}\n`;
        consumed += 1;
      } else {
        break;
      }
    }
    return {
      hunk: { kind: "add", path: targetPath, contents },
      consumed,
    };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const targetPath = firstLine.slice(DELETE_FILE_MARKER.length);
    return {
      hunk: { kind: "delete", path: targetPath },
      consumed: 1,
    };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const targetPath = firstLine.slice(UPDATE_FILE_MARKER.length);
    let remaining = lines.slice(1);
    let consumed = 1;
    let movePath: string | undefined;

    const moveCandidate = remaining[0]?.trim();
    if (moveCandidate?.startsWith(MOVE_TO_MARKER)) {
      movePath = moveCandidate.slice(MOVE_TO_MARKER.length);
      remaining = remaining.slice(1);
      consumed += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      if (remaining[0].trim() === "") {
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }
      if (remaining[0].startsWith("***")) {
        break;
      }
      const { chunk, consumed: chunkLines } = parseUpdateFileChunk(
        remaining,
        lineNumber + consumed,
        chunks.length === 0,
      );
      chunks.push(chunk);
      remaining = remaining.slice(chunkLines);
      consumed += chunkLines;
    }

    if (chunks.length === 0) {
      throw new Error(`无效补丁（行 ${lineNumber}）：Update 块为空 '${targetPath}'`);
    }

    return {
      hunk: {
        kind: "update",
        path: targetPath,
        movePath,
        chunks,
      },
      consumed,
    };
  }

  throw new Error(
    `无效补丁（行 ${lineNumber}）：应以 '*** Add File:' / '*** Delete File:' / '*** Update File:' 开头`,
  );
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumed: number } {
  if (lines.length === 0) {
    throw new Error(`无效更新块（行 ${lineNumber}）：无内容`);
  }

  let changeContext: string | undefined;
  let startIndex = 0;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new Error(
      `无效更新块（行 ${lineNumber}）：应以 @@ 上下文开始，实际为 '${lines[0]}'`,
    );
  }

  if (startIndex >= lines.length) {
    throw new Error(`无效更新块（行 ${lineNumber + 1}）：无正文`);
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };

  let parsedLines = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new Error(`无效更新块（行 ${lineNumber + 1}）：*** End of File 前无行`);
      }
      chunk.isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line[0];
    if (!marker) {
      chunk.oldLines.push("");
      chunk.newLines.push("");
      parsedLines += 1;
      continue;
    }

    if (marker === " ") {
      const content = line.slice(1);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
      parsedLines += 1;
      continue;
    }
    if (marker === "+") {
      chunk.newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (marker === "-") {
      chunk.oldLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }

    if (parsedLines === 0) {
      throw new Error(
        `无效更新行 '${line}'：应以空格/+/- 开头`,
      );
    }
    break;
  }

  return { chunk, consumed: parsedLines + startIndex };
}
