/**
 * 肢体错误：一个 code + 是否可重试 + 明细。
 *
 * code 优先取协议错误码（见 proto.Code），本地失败用 CLIENT_* 前缀，
 * 便于调用方按码分流而不是匹配文案。
 */
export type LocalCode =
  | 'CLIENT_NOT_CONNECTED'
  | 'CLIENT_TIMEOUT'
  | 'CLIENT_EVICTED'
  | 'CLIENT_CONFIG'
  | 'CLIENT_HANDSHAKE'

export class BodyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BodyError'
  }

  static notConnected(message = 'body is not connected'): BodyError {
    return new BodyError(message, 'CLIENT_NOT_CONNECTED', true)
  }

  static timeout(message: string): BodyError {
    return new BodyError(message, 'CLIENT_TIMEOUT', true)
  }

  static config(message: string): BodyError {
    return new BodyError(message, 'CLIENT_CONFIG', false)
  }

  static from(error: unknown): BodyError {
    if (error instanceof BodyError) return error
    const err = error as Error & { code?: string; details?: Record<string, unknown> }
    if (typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code)) {
      return new BodyError(err.message || err.code, err.code, false, err.details)
    }
    return new BodyError(err?.message || String(error), 'CLIENT_NOT_CONNECTED', true)
  }
}

export function isBodyError(value: unknown): value is BodyError {
  return value instanceof BodyError
}
