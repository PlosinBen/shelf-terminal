import type { LogLevel } from './types';

const LEVELS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = 'error';

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] <= LEVELS[currentLevel];
}

export const log = {
  error(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('error')) console.error(`[${tag}]`, msg, ...args);
  },
  info(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('info')) console.log(`[${tag}]`, msg, ...args);
  },
  debug(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('debug')) console.log(`[${tag}:debug]`, msg, ...args);
  },
};
