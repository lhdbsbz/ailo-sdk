/**
 * grep 工具 — 对齐 tools-contract §3.6。
 * 优先调本机 rg（ripgrep），不可用时回退纯 TS 实现。
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { validateArgs } from "./param_validator.js";

const DEFAULT_HEAD_LIMIT = 50;

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: string;
  head_limit?: number;
}

export function grepTool(args: Record<string, unknown>): string {
  const validated = validateArgs<GrepArgs>(args, {
    pattern: { type: "string", required: true },
    path: { type: "string" },
    glob: { type: "string" },
    output_mode: { type: "string", default: "content" },
    head_limit: { type: "number", default: DEFAULT_HEAD_LIMIT, min: 1 },
  });

  const pattern = validated.pattern.trim();
  if (!pattern) {
    return JSON.stringify({ ok: false, code: "invalid_params", error: "pattern is required" });
  }

  const searchPath = validated.path?.trim() || process.cwd();
  const mode = validated.output_mode === "files_with_matches" ? "files_with_matches" : "content";
  const headLimit = validated.head_limit ?? DEFAULT_HEAD_LIMIT;

  let rgAvailable = true;
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
  } catch {
    rgAvailable = false;
  }

  try {
    const matches = rgAvailable
      ? runRg(pattern, searchPath, validated.glob, mode, headLimit)
      : runFallback(pattern, searchPath, validated.glob, mode, headLimit);

    const truncated = matches.truncated;
    return JSON.stringify({
      ok: true,
      output_mode: mode,
      matches: matches.lines,
      truncated,
    });
  } catch (err: unknown) {
    return JSON.stringify({
      ok: false,
      code: "invalid_pattern",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface MatchResult {
  lines: string[];
  truncated: boolean;
}

function runRg(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  mode: string,
  headLimit: number,
): MatchResult {
  const cmdArgs = ["--color", "never", "--line-number"];
  if (mode === "files_with_matches") {
    cmdArgs.push("--files-with-matches");
  }
  if (globFilter) {
    cmdArgs.push("--glob", globFilter);
  }
  cmdArgs.push(pattern, searchPath);

  let output: string;
  try {
    output = execFileSync("rg", cmdArgs, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) {
      return { lines: [], truncated: false };
    }
    throw err;
  }

  if (!output) return { lines: [], truncated: false };
  const lines = output.split("\n");
  const truncated = lines.length > headLimit;
  return { lines: truncated ? lines.slice(0, headLimit) : lines, truncated };
}

function runFallback(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  mode: string,
  headLimit: number,
): MatchResult {
  const re = new RegExp(pattern);
  const results: string[] = [];
  let truncated = false;

  function walk(dir: string): void {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (name === ".git" || name === "node_modules" || (name.startsWith(".") && name !== ".")) continue;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (globFilter) {
          const base = path.basename(full);
          const rel = path.relative(searchPath, full);
          if (!simpleMatch(globFilter, base) && !simpleMatch(globFilter, rel)) continue;
        }
        searchFile(full);
      }
    }
  }

  function searchFile(filePath: string): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (truncated) return;
      if (re.test(lines[i])) {
        if (mode === "files_with_matches") {
          results.push(filePath);
          return;
        }
        results.push(`${filePath}:${i + 1}:${lines[i]}`);
        if (results.length >= headLimit) {
          truncated = true;
          return;
        }
      }
    }
  }

  const stat = fs.statSync(searchPath);
  if (stat.isFile()) {
    searchFile(searchPath);
  } else {
    walk(searchPath);
  }

  return { lines: results, truncated };
}

function simpleMatch(pattern: string, str: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|\\[\]]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(str);
}
