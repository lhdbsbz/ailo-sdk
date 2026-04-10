export type ErrorCode =
  | 'NETWORK'
  | 'PROTOCOL'
  | 'TIMEOUT'
  | 'AUTH'
  | 'BUSINESS'
  | 'INVALID_PARAMS'
  | 'NOT_CONNECTED'
  | 'HANDSHAKE_FAILED'
  | 'EVICTED'
  | 'FILE_NOT_FOUND'
  | 'VALIDATION'
  | 'EXECUTION'
  | 'CONFIG'
  | 'PATH_ERROR';

/**
 * 错误分类枚举 - 用于细粒度错误识别
 */
export type ErrorCategory =
  | 'connection'    // 连接相关错误
  | 'file'          // 文件系统错误
  | 'validation'    // 参数/配置验证错误
  | 'execution'     // 代码执行错误
  | 'browser'       // 浏览器操作错误
  | 'mcp'           // MCP 服务错误
  | 'config'        // 配置错误
  | 'unknown';      // 未知错误

export class EndpointError extends Error {
  public readonly timestamp: Date;

  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean = true,
    public readonly cause?: Error,
    public readonly category?: ErrorCategory,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EndpointError';
    this.timestamp = new Date();
  }

  /**
   * 获取完整错误信息
   */
  getFullMessage(): string {
    const parts = [`[${this.code}]`, this.message];
    if (this.category) parts.unshift(`[${this.category}]`);
    return parts.join(' ');
  }

  /**
   * 转换为 JSON 格式
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
      timestamp: this.timestamp.toISOString(),
      cause: this.cause?.message,
    };
  }

  static network(message: string, cause?: Error): EndpointError {
    return new EndpointError(message, 'NETWORK', true, cause, 'connection');
  }

  static timeout(message: string, category?: ErrorCategory): EndpointError {
    return new EndpointError(message, 'TIMEOUT', true, undefined, category ?? 'execution');
  }

  static auth(message: string): EndpointError {
    return new EndpointError(message, 'AUTH', false, undefined, 'connection');
  }

  static protocol(message: string): EndpointError {
    return new EndpointError(message, 'PROTOCOL', false, undefined, 'connection');
  }

  static notConnected(): EndpointError {
    return new EndpointError('Not connected to server', 'NOT_CONNECTED', true, undefined, 'connection');
  }

  static handshakeFailed(message: string, cause?: Error): EndpointError {
    return new EndpointError(message, 'HANDSHAKE_FAILED', true, cause, 'connection');
  }

  static evicted(): EndpointError {
    return new EndpointError('Evicted by newer instance', 'EVICTED', false, undefined, 'connection');
  }

  static invalidParams(message: string, details?: Record<string, unknown>): EndpointError {
    return new EndpointError(message, 'INVALID_PARAMS', false, undefined, 'validation', details);
  }

  static business(message: string, details?: Record<string, unknown>): EndpointError {
    return new EndpointError(message, 'BUSINESS', true, undefined, 'unknown', details);
  }

  // 新增：文件系统错误
  static fileNotFound(path: string): EndpointError {
    return new EndpointError(`File not found: ${path}`, 'FILE_NOT_FOUND', true, undefined, 'file', { path });
  }

  static pathError(message: string, path?: string): EndpointError {
    return new EndpointError(message, 'PATH_ERROR', false, undefined, 'file', { path });
  }

  // 新增：配置错误
  static config(message: string, details?: Record<string, unknown>): EndpointError {
    return new EndpointError(message, 'CONFIG', false, undefined, 'config', details);
  }

  // 新增：执行错误
  static execution(message: string, command?: string): EndpointError {
    return new EndpointError(message, 'EXECUTION', true, undefined, 'execution', { command });
  }

  // 新增：验证错误
  static validation(message: string, param?: string, expected?: string, actual?: string): EndpointError {
    return new EndpointError(message, 'VALIDATION', false, undefined, 'validation', { param, expected, actual });
  }
}

/**
 * 判断是否为 EndpointError
 */
export function isEndpointError(error: unknown): error is EndpointError {
  return error instanceof EndpointError;
}

/**
 * 将未知错误转换为 EndpointError
 */
export function toEndpointError(error: unknown, category?: ErrorCategory): EndpointError {
  if (isEndpointError(error)) return error;
  if (error instanceof Error) {
    return new EndpointError(error.message, 'BUSINESS', true, error, category ?? 'unknown', { originalName: error.name });
  }
  return new EndpointError(String(error), 'BUSINESS', true, undefined, 'unknown');
}
