/**
 * glob 工具 — 对齐 tools-contract §3.5。
 * 在 target_directory 下递归匹配文件名，跳过 .git/node_modules/隐藏目录。
 */

import * as fs from "fs";
import * as path from "path";
import { validateArgs } from "./param_validator.js";
import { requireAbsPath } from "./path_utils.js";

const MAX_MATCHES = 200;
const SKIP_DIRS = new Set([".git", "node_modules"]);

interface GlobArgs {
  pattern: string;
  target_directory: string;
}

export function globTool(args: Record<string, unknown>): string {
  const validated = validateArgs<GlobArgs>(args, {
    pattern: { type: "string", required: true },
    target_directory: { type: "string", required: true },
  });

  const pattern = validated.pattern.trim();
  if (!pattern) {
    return JSON.stringify({ ok: false, code: "invalid_params", error: "pattern is required" });
  }

  let baseDir: string;
  try {
    baseDir = requireAbsPath(validated.target_directory, "target_directory");
  } catch (e: unknown) {
    return JSON.stringify({
      ok: false,
      code: "invalid_path",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
    return JSON.stringify({
      ok: false,
      code: "invalid_path",
      error: `target_directory does not exist or is not a directory: ${baseDir}`,
    });
  }

  const matches: string[] = [];
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
      if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".")) continue;
      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, fullPath);
        if (matchGlob(pattern, name) || matchGlob(pattern, rel)) {
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            return;
          }
          matches.push(fullPath);
        }
      }
    }
  }

  walk(baseDir);
  matches.sort();

  return JSON.stringify({ ok: true, matches, truncated });
}

function matchGlob(pattern: string, str: string): boolean {
  const re = globToRegex(pattern);
  return re.test(str);
}

function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += "[" + glob.slice(i + 1, end) + "]";
        i = end;
      }
    } else if (".+^${}()|\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}
