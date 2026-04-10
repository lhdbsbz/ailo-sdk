/**
 * 工具读取状态跟踪
 *
 * 用途：
 * 1. 新鲜度检查：edit_file 时检查文件是否自上次 read 后被外部修改
 * 2. 去重：重复读取未变化文件时返回 stub 而非重发内容（节省 token）
 *
 * 简单模块级 singleton，endpoint 重连时 reset。
 */

import * as fs from "fs";
import * as path from "path";

interface FileReadState {
  content: string;       // 上次读取的完整内容
  mtime: Date;           // 上次读取时的修改时间
  readAt: number;        // 读取时间戳（ms）
  offset: number;        // 读取起始行
  limit: number;         // 读取行数限制
}

const readFileState = new Map<string, FileReadState>();

/**
 * 记录文件读取状态
 */
export function markFileRead(filePath: string, content: string, mtime: Date, offset: number, limit: number): void {
  readFileState.set(filePath, {
    content,
    mtime,
    readAt: Date.now(),
    offset,
    limit,
  });
}

/**
 * 检查文件是否被外部修改（新鲜度检查）
 * @returns true 表示文件已被外部修改，需要重新读取
 */
export function isFileStale(filePath: string): boolean {
  const state = readFileState.get(filePath);
  if (!state) return true; // 从未读过，视为过期

  try {
    const currentStat = fs.statSync(filePath);
    return currentStat.mtimeMs !== state.mtime.getTime();
  } catch {
    return true; // 文件不存在或被删除
  }
}

/**
 * 获取上次读取的内容（用于去重）
 * @returns null 表示文件未读过或已变化
 */
export function getCachedContent(filePath: string): string | null {
  const state = readFileState.get(filePath);
  if (!state) return null;

  try {
    const currentStat = fs.statSync(filePath);
    if (currentStat.mtimeMs !== state.mtime.getTime()) return null;
  } catch {
    return null;
  }

  return state.content;
}

/**
 * 检查文件是否被读过（用于 edit_file 前置检查）
 */
export function hasBeenRead(filePath: string): boolean {
  return readFileState.has(filePath);
}

/**
 * 清除特定文件的读取状态
 */
export function clearFileState(filePath: string): void {
  readFileState.delete(filePath);
}

/**
 * 重置所有读取状态（endpoint 重连时调用）
 */
export function resetToolContext(): void {
  readFileState.clear();
}

/**
 * 获取读取状态摘要（调试用）
 */
export function getStateSummary(): { file: string; age: string; stale: boolean }[] {
  const now = Date.now();
  return Array.from(readFileState.entries()).map(([file, state]) => ({
    file,
    age: `${((now - state.readAt) / 1000).toFixed(0)}s`,
    stale: isFileStale(file),
  }));
}
