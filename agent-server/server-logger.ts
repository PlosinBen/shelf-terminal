// agent-server has NO independent observability: it can't use @shared/logger
// (that writes a file via electron `app.getPath`, and there is no electron
// here), and its stdout is the JSON wire protocol. So every diagnostic is
// routed to MAIN over the wire as a `{type:'log'}` message, where main's
// @shared/logger applies the level filter and writes the file. The ONLY thing
// that may still hit stderr is a fatal crash (Node's default uncaught dump) or
// a log emitted before the wire sink is wired up (boot fallback below).
//
// Level filtering happens at main (single source of truth), so we emit every
// level and let main drop what's below its threshold.

export type ServerLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ServerLogMessage {
  type: 'log';
  level: ServerLogLevel;
  tag: string;
  msg: string;
}

let sink: ((m: ServerLogMessage) => void) | null = null;

/** Wire the sink to the stdout JSON-line writer. Called once at startup. */
export function setLogSink(fn: (m: ServerLogMessage) => void): void {
  sink = fn;
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Log from agent-server. `args` are flattened to text HERE (where Error objects
 * are still intact — they'd serialize to `{}` if sent raw over the wire). Before
 * the sink is wired (early boot), falls back to stderr so nothing is lost.
 */
export function serverLog(level: ServerLogLevel, tag: string, msg: string, ...args: unknown[]): void {
  const text = args.length ? `${msg} ${args.map(fmt).join(' ')}` : msg;
  if (sink) {
    sink({ type: 'log', level, tag, msg: text });
  } else {
    console.error(`[${level}][${tag}] ${text}`); // pre-wire fallback → stderr
  }
}
