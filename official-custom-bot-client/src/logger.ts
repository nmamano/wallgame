/**
 * Simple logger with configurable log levels
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(...args: unknown[]): void {
    if (shouldLog("debug")) {
      console.debug(`[${timestamp()}] [DEBUG]`, ...args);
    }
  },

  info(...args: unknown[]): void {
    if (shouldLog("info")) {
      console.log(`[${timestamp()}] [INFO]`, ...args);
    }
  },

  warn(...args: unknown[]): void {
    if (shouldLog("warn")) {
      console.warn(`[${timestamp()}] [WARN]`, ...args);
    }
  },

  error(...args: unknown[]): void {
    if (shouldLog("error")) {
      console.error(`[${timestamp()}] [ERROR]`, ...args);
    }
  },
};
