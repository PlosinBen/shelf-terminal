// Named-channel log sink (main) — the destination for agent-server
// wireLogger.channel(name) records arriving over the wire. Each channel is
// materialized as its own file (logs/<channel>/MMDD.log), keeping a feature's
// diagnostic stream out of the main log. main owns the fs mapping; agent-server
// only names the channel. Wired in main bootstrap (setChannelWriter).

let writer: ((channel: string, line: string) => void) | null = null;

export function setChannelWriter(fn: (channel: string, line: string) => void): void {
  writer = fn;
}

/** Restrict a channel name to a safe path segment (defends against traversal /
 *  odd chars, since the name becomes a directory). Empty → 'unnamed'. */
export function sanitizeChannel(channel: string): string {
  const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  // No alphanumerics (empty, '//', '..', all-punctuation) → a stable placeholder
  // rather than an ugly '__' dir.
  return /[a-zA-Z0-9]/.test(safe) ? safe : 'unnamed';
}

/** Write one line to the named channel. No-op until a writer is wired. */
export function channelLog(channel: string, level: string, tag: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}][${tag}] ${msg}`;
  writer?.(sanitizeChannel(channel), line);
}
