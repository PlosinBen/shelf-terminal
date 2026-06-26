import type { LogLevel } from './types';

const LEVELS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
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
  // error/warn → stderr; info/debug → stdout. (level is the upper-case display tag.)
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
  fileWriter?.(line);
}

// In-memory ring buffer of診斷用 trace 訊息。不過 level check、不寫檔，
// 只有 flushTrace() 被觸發時才整批當 error 倒出來，確保正常情況下不污染 log。
const TRACE_BUFFER_MAX = 200;
const traceBuffer: Array<{ tag: string; msg: string; iso: string }> = [];

export const log = {
  error(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('error')) write('ERROR', tag, msg, args);
  },
  warn(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('warn')) write('WARN', tag, msg, args);
  },
  info(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('info')) write('INFO', tag, msg, args);
  },
  debug(tag: string, msg: string, ...args: unknown[]) {
    if (shouldLog('debug')) write('DEBUG', tag, msg, args);
  },
  trace(tag: string, msg: string) {
    traceBuffer.push({ tag, msg, iso: new Date().toISOString() });
    if (traceBuffer.length > TRACE_BUFFER_MAX) traceBuffer.shift();
  },
  flushTrace(tag: string, reason: string) {
    if (traceBuffer.length === 0) {
      write('ERROR', tag, `flushTrace: no entries (reason: ${reason})`, []);
      return;
    }
    write('ERROR', tag, `flushTrace: ${traceBuffer.length} entries follow (reason: ${reason})`, []);
    for (const e of traceBuffer) {
      const line = `${e.iso} [TRACE][${e.tag}] ${e.msg}`;
      console.error(line);
      fileWriter?.(line);
    }
    traceBuffer.length = 0;
  },
};
