import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";

const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_DEPTH = 10;
const MAX_FIND_RESULTS = 200;
const IGNORED_DIRS = ["node_modules", ".git"];
/** 单次 read_file 最大字节数，超出则分块读取并截断提示 */
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB

type Args = Record<string, unknown>;

function requireAbsPath(p: string, param: string): string {
  if (!p) throw new Error(`${param} 不能为空`);
  if (!path.isAbsolute(p)) {
    throw new Error(`${param} 必须是绝对路径，收到相对路径: "${p}"`);
  }
  return p;
}

export async function fsTool(name: string, args: Args): Promise<string> {
  switch (name) {
    case "read_file":
      return readFile(args);
    case "write_file":
      return writeFile(args);
    case "edit_file":
      return editFile(args);
    case "list_directory":
      return listDirectory(args);
    case "find_files":
      return findFiles(args);
    case "search_content":
      return searchContent(args);
    case "delete_file":
      return deleteFile(args);
    case "move_file":
      return moveFile(args);
    case "copy_file":
      return copyFile(args);
    case "append_file":
      return appendFile(args);
    default:
      throw new Error(`unknown fs tool: ${name}`);
  }
}

function readFile(args: Args): string {
  const filePath = requireAbsPath(args.path as string, "path");
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`路径不是文件: ${filePath}`);
  const offset = Math.max(0, ((args.offset as number) ?? 1) - 1);
  const limit = (args.limit as number) ?? undefined;

  let content: string;
  if (stat.size > MAX_READ_BYTES) {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(MAX_READ_BYTES);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    content = buf.toString("utf-8");
    content += `\n...[文件已截断，共 ${stat.size} 字节，仅显示前 ${MAX_READ_BYTES} 字节。可用 offset/limit 分页读取]`;
  } else {
    content = fs.readFileSync(filePath, "utf-8");
  }

  const lines = content.split("\n");
  const slice = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
  return slice.map((line, i) => `${String(offset + i + 1).padStart(6)}|${line}`).join("\n");
}

function writeFile(args: Args): string {
  const filePath = requireAbsPath(args.path as string, "path");
  const content = args.content as string;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return `已写入 ${filePath}（${content.length} 字符）`;
}

function editFile(args: Args): string {
  const filePath = requireAbsPath(args.path as string, "path");
  const oldStr = args.old_string as string;
  const newStr = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  let content = fs.readFileSync(filePath, "utf-8");

  if (!content.includes(oldStr)) {
    throw new Error("old_string 在文件中未找到");
  }

  if (replaceAll) {
    content = content.split(oldStr).join(newStr);
  } else {
    const idx = content.indexOf(oldStr);
    content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return `已编辑 ${filePath}`;
}

function listDirectory(args: Args): string {
  const dirPath = requireAbsPath(args.path as string, "path");
  if (!fs.existsSync(dirPath)) throw new Error(`目录不存在: ${dirPath}`);
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = entries.map((e) => {
    const suffix = e.isDirectory() ? "/" : "";
    try {
      const stat = fs.statSync(path.join(dirPath, e.name));
      const size = e.isDirectory() ? "-" : formatSize(stat.size);
      return `${e.name}${suffix}  (${size})`;
    } catch {
      return `${e.name}${suffix}`;
    }
  });
  return lines.join("\n") || "(空目录)";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function findFiles(args: Args): Promise<string> {
  const pattern = args.pattern as string;
  const directory = requireAbsPath((args.directory as string) || process.cwd(), "directory");
  const maxResults = (args.max_results as number) || MAX_FIND_RESULTS;

  const matches = await glob(pattern, {
    cwd: directory,
    absolute: true,
    nodir: false,
    ignore: IGNORED_DIRS.map(d => `**/${d}/**`),
  });

  const limited = matches.slice(0, maxResults);
  if (limited.length === 0) return "未找到匹配文件";
  let result = limited.join("\n");
  if (matches.length > maxResults) {
    result += `\n... 还有 ${matches.length - maxResults} 个结果`;
  }
  return result;
}

function searchContent(args: Args): string {
  const query = args.query as string;
  const directory = requireAbsPath((args.directory as string) || process.cwd(), "directory");
  const useRegex = (args.regex as boolean) ?? false;
  const ignoreCase = (args.ignore_case as boolean) ?? false;
  const contextLines = (args.context_lines as number) ?? 0;

  let pattern: RegExp;
  try {
    pattern = useRegex
      ? new RegExp(query, ignoreCase ? "gi" : "g")
      : new RegExp(escapeRegex(query), ignoreCase ? "gi" : "g");
  } catch {
    throw new Error(`无效的正则表达式: "${query}"`);
  }

  const results: string[] = [];
  searchDir(directory, pattern, contextLines, results, 0, MAX_SEARCH_RESULTS);
  return results.join("\n") || "未找到匹配内容";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchDir(dir: string, pattern: RegExp, ctx: number, results: string[], depth: number, limit: number): void {
  if (depth > MAX_SEARCH_DEPTH || results.length >= limit) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (results.length >= limit) return;
    const full = path.join(dir, e.name);
    if (IGNORED_DIRS.includes(e.name)) continue;
    if (e.isDirectory()) {
      searchDir(full, pattern, ctx, results, depth + 1, limit);
    } else if (e.isFile()) {
      try {
        const content = fs.readFileSync(full, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            const start = Math.max(0, i - ctx);
            const end = Math.min(lines.length, i + ctx + 1);
            const block = lines.slice(start, end).map((l, j) => {
              const lineNum = start + j + 1;
              const marker = (start + j === i) ? ":" : "-";
              return `${String(lineNum).padStart(4)}${marker} ${l}`;
            });
            results.push(`${full}:\n${block.join("\n")}`);
            if (results.length >= limit) return;
          }
        }
      } catch { /* skip binary / unreadable files */ }
    }
  }
}

function deleteFile(args: Args): string {
  const filePath = requireAbsPath(args.path as string, "path");
  const recursive = (args.recursive as boolean) ?? false;
  if (!fs.existsSync(filePath)) throw new Error(`路径不存在: ${filePath}`);
  fs.rmSync(filePath, { recursive, force: true });
  return `已删除 ${filePath}`;
}

function moveFile(args: Args): string {
  const src = requireAbsPath(args.source as string, "source");
  const dst = requireAbsPath(args.destination as string, "destination");
  if (!fs.existsSync(src)) throw new Error(`源路径不存在: ${src}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return `已移动 ${src} → ${dst}`;
}

function copyFile(args: Args): string {
  const src = requireAbsPath(args.source as string, "source");
  const dst = requireAbsPath(args.destination as string, "destination");
  if (!fs.existsSync(src)) throw new Error(`源路径不存在: ${src}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.copyFileSync(src, dst);
  }
  return `已复制 ${src} → ${dst}`;
}

function appendFile(args: Args): string {
  const filePath = requireAbsPath(args.path as string, "path");
  const content = args.content as string;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content, "utf-8");
  return `已追加到 ${filePath}（${content.length} 字符）`;
}
