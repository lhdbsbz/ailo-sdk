import type { BodyContext } from "@greatlhd/ailo-body";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function createChannelLogger(
  prefix: string,
  getCtx: () => BodyContext | null,
): (level: LogLevel, message: string, data?: Record<string, unknown>) => void {
  return (level, message, data) => {
    const ctx = getCtx();
    if (ctx?.log) {
      ctx.log(level, message, data);
    } else {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
      fn(`[${prefix}] ${message}`, data ?? "");
    }
  };
}
