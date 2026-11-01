/**
 * 工具读取状态跟踪
 *
 * 用途：
 * 1. 新鲜度检查：edit_file 时检查文件是否自上次 read 后被外部修改
 * 2. 去重：重复读取未变化文件时返回 stub 而非重发内容（节省 token）
 *
 * 简单模块级 singleton，肢体重连时 reset。
 */

import * as fs from "fs";

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
/**
 * mtimeMs 是浮点（NTFS 100ns / APFS 1ns），Date.getTime() 只有整毫秒，
 * 直接相等比较会把"刚读过"判成"已修改"。差 1ms 以内视为同一版本。
 */
function mtimeChanged(filePath: string, recorded: Date): boolean {
  const currentMs = fs.statSync(filePath).mtimeMs;
  return Math.abs(currentMs - recorded.getTime()) >= 1;
}

export function isFileStale(filePath: string): boolean {
  const state = readFileState.get(filePath);
  if (!state) return true; // 从未读过，视为过期

  try {
    return mtimeChanged(filePath, state.mtime);
  } catch {
    return true; // 文件不存在或被删除
  }
}

/**
 * 清除特定文件的读取状态
 */
export function clearFileState(filePath: string): void {
  readFileState.delete(filePath);
}

/**
 * 重置所有读取状态（肢体重连时调用）
 */
export function resetToolContext(): void {
  readFileState.clear();
}
