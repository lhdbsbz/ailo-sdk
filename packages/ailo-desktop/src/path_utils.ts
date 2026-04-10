import { isAbsolute, resolve as resolvePath } from "path";

/**
 * 将路径参数解析为绝对路径：已是绝对路径则规范化；相对路径相对 `process.cwd()`。
 * 不做端点级目录/系统路径限制（以 OS 与启动用户对端点进程的权限为界）。
 */
export function requireAbsPath(p: string, param: string): string {
  if (!p || typeof p !== "string" || !p.trim()) {
    throw new Error(`${param} 不能为空`);
  }
  const trimmed = p.trim();
  return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(process.cwd(), trimmed);
}

export function optionalAbsPath(value: unknown, paramName: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return requireAbsPath(value, paramName);
}
