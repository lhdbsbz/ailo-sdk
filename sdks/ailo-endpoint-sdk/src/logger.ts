export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 日志级别枚举（数值型，便于比较）
 */
export enum LogLevelValue {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogData {
  [key: string]: unknown;
}

export interface Logger {
  error(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  debug(event: string, data?: LogData): void;
  // 新增：level-based API
  log(level: LogLevelValue, component: string, message: string, data?: LogData): void;
  setLevel(level: LogLevelValue): void;
  getLevel(): LogLevelValue;
}

export class ConsoleLogger implements Logger {
  private level: LogLevelValue;

  constructor(private prefix: string = '[endpoint]') {
    // 如果设置了 DEBUG 环境变量，默认级别为 DEBUG
    this.level = (process.env.DEBUG || process.env.NODE_ENV === 'development')
      ? LogLevelValue.DEBUG
      : LogLevelValue.INFO;
  }

  error(event: string, data?: LogData): void {
    this.log(LogLevelValue.ERROR, 'endpoint', event, data);
  }

  warn(event: string, data?: LogData): void {
    this.log(LogLevelValue.WARN, 'endpoint', event, data);
  }

  info(event: string, data?: LogData): void {
    this.log(LogLevelValue.INFO, 'endpoint', event, data);
  }

  debug(event: string, data?: LogData): void {
    this.log(LogLevelValue.DEBUG, 'endpoint', event, data);
  }

  /**
   * 统一的日志输出方法
   */
  log(level: LogLevelValue, component: string, message: string, data?: LogData): void {
    if (level < this.level) return;

    const timestamp = new Date().toISOString();
    const levelName = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE'][level];
    // 使用正确的 console 方法
    const output = level === LogLevelValue.ERROR ? console.error
                  : level === LogLevelValue.WARN ? console.warn
                  : console.log;

    const formattedMessage = `${timestamp} [${this.prefix}] [${component}] [${levelName}] ${message}`;
    if (data && Object.keys(data).length > 0) {
      output(formattedMessage, data);
    } else {
      output(formattedMessage);
    }
  }

  setLevel(level: LogLevelValue): void {
    this.level = level;
  }

  getLevel(): LogLevelValue {
    return this.level;
  }
}

export class NoopLogger implements Logger {
  private level: LogLevelValue = LogLevelValue.NONE;

  error(): void {}
  warn(): void {}
  info(): void {}
  debug(): void {}
  log(): void {}
  setLevel(level: LogLevelValue): void { this.level = level; }
  getLevel(): LogLevelValue { return this.level; }
}

/**
 * 创建组件专用 Logger
 */
export function createComponentLogger(component: string, baseLogger: Logger): Logger {
  return {
    error: (event: string, data?: LogData) => baseLogger.log(LogLevelValue.ERROR, component, event, data),
    warn: (event: string, data?: LogData) => baseLogger.log(LogLevelValue.WARN, component, event, data),
    info: (event: string, data?: LogData) => baseLogger.log(LogLevelValue.INFO, component, event, data),
    debug: (event: string, data?: LogData) => baseLogger.log(LogLevelValue.DEBUG, component, event, data),
    log: (level: LogLevelValue, _c: string, message: string, data?: LogData) => baseLogger.log(level, component, message, data),
    setLevel: (level: LogLevelValue) => baseLogger.setLevel(level),
    getLevel: () => baseLogger.getLevel(),
  };
}
