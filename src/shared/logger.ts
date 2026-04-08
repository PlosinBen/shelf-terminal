import type { LogLevel } from './types';

const LEVELS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = 'error';
let fileWriter: ((line: string) => void) | null = null;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setFileWriter(writer: (line: string) => void) {
  fileWriter = writer;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] <= LEVELS[currentLevel];
}

function write(level: string, tag: string, msg: string, args: unknown[]) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level}][${tag}] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  fileWriter?.(line);
}

export const log = {
  error(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('error')) write('ERROR', tag, msg, args);
  },
  info(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('info')) write('INFO', tag, msg, args);
  },
  debug(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('debug')) write('DEBUG', tag, msg, args);
  },
};
