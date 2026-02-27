/**
 * 配置 / 重连 / 退避 工具 — 供桌面端及其他 SDK 应用复用。
 *
 * 模式（可推广到全部 SDK 应用）：
 * - 配置保存后：主动断线，用最新配置重连（已连 → client.reconnect(undefined, cfg)；未连 → runEndpoint(cfg)）。
 * - 连接失败：onConnectFailure 内退避等待，再 client.reconnect(undefined, loadConnectionConfig())，每次用最新配置。
 *
 * 使用示例见本包 index.ts 的 applyConnectionConfig + onConnectionConfigSaved + onConnectFailure。
 */

import { config as loadEnv } from "dotenv";

/** Ailo 连接配置（与 .env / 配置页一致） */
export interface AiloConnectionConfig {
  url: string;
  apiKey: string;
  endpointId: string;
  displayName?: string;
}

/** 从 .env 重新加载并返回当前连接配置（每次重试前调用以拿到最新配置） */
export function loadConnectionConfig(envFilePath: string): AiloConnectionConfig {
  loadEnv({ path: envFilePath });
  return {
    url: process.env.AILO_WS_URL ?? "",
    apiKey: process.env.AILO_API_KEY ?? "",
    endpointId: process.env.AILO_ENDPOINT_ID ?? "",
    displayName: process.env.DISPLAY_NAME,
  };
}

/** 是否具备有效连接配置 */
export function hasValidConfig(c: AiloConnectionConfig): boolean {
  return !!(c.url && c.apiKey && c.endpointId);
}

/**
 * 指数退避延迟（毫秒）。可选加少量抖动，避免多实例同时重试。
 * @param attempt 当前为第几次尝试（0-based）
 * @param baseMs 基础间隔，默认 1000
 * @param maxMs 上限，默认 60_000
 * @param jitter 是否加 ±10% 抖动，默认 true
 */
export function backoffDelayMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 60_000,
  jitter = true,
): number {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs);
  if (!jitter) return raw;
  const spread = raw * 0.1 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(raw + spread));
}
