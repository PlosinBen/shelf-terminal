// Shared internals for the agent-server logger facade (wireLogger / rawLogger).
//
// agent-server has no local log file (no electron, stdout is the wire protocol),
// so every diagnostic is either shipped to main over the wire (wireLogger) or —
// only when the wire is presumed dead — written straight to stderr (rawLogger).
// This module holds the wire sink injection + formatting; the two loggers are
// separate entry points (see wire.ts / raw.ts) so a call site's import declares
// where its logs go.

import type { ServerLogLevel } from '../server-logger';

/**
 * Named log tags — avoid magic strings at call sites (house convention, cf.
 * IPC / SHELF_PLACEMENTS). Referenced as the first arg: `wireLogger.info(LogTag.copilot, …)`.
 * Grows as call sites adopt the facade.
 */
export const LogTag = {
  copilot: 'copilot',
} as const;
export type LogTag = (typeof LogTag)[keyof typeof LogTag];

export interface WireLogMessage {
  type: 'log';
  level: ServerLogLevel;
  tag: string;
  msg: string;
  /**
   * Optional named channel. Main materializes it as its own log file
   * (logs/<channel>/MMDD.log); absent → main's default log. agent-server only
   * names the channel — the physical file is main's decision (it owns the fs).
   */
  channel?: string;
}

type WireSink = (m: WireLogMessage) => void;
let wireSink: WireSink | null = null;

/** Inject the process's wire writer. exec / dispatcher each wire their own at boot. */
export function setWireSink(fn: WireSink): void {
  wireSink = fn;
}

/** Flatten one log arg to text HERE (Error stacks survive; they'd serialize to `{}` over the wire). */
export function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Emit one wire log record via the injected sink. Before the sink is wired
 * (early boot), falls back to stderr so nothing is lost — mirrors serverLog.
 */
export function emitWire(
  level: ServerLogLevel,
  tag: string,
  channel: string | undefined,
  msg: string,
  args: unknown[],
): void {
  const text = args.length ? `${msg} ${args.map(fmt).join(' ')}` : msg;
  if (wireSink) {
    wireSink({ type: 'log', level, tag, msg: text, channel });
  } else {
    process.stderr.write(`[${level}][${tag}]${channel ? `[${channel}]` : ''} ${text}\n`);
  }
}
