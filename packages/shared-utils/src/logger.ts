/**
 * Logger — Structured logging with severity levels.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

export class Logger {
  private static level = LogLevel.INFO;
  private prefix: string;

  constructor(module: string) {
    this.prefix = `[${module}]`;
  }

  static setLevel(level: LogLevel): void {
    Logger.level = level;
  }

  debug(...args: unknown[]): void {
    if (Logger.level <= LogLevel.DEBUG) {
      console.debug(this.prefix, ...args);
    }
  }

  info(...args: unknown[]): void {
    if (Logger.level <= LogLevel.INFO) {
      console.info(this.prefix, ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (Logger.level <= LogLevel.WARN) {
      console.warn(this.prefix, ...args);
    }
  }

  error(...args: unknown[]): void {
    if (Logger.level <= LogLevel.ERROR) {
      console.error(this.prefix, ...args);
    }
  }
}
