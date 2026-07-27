// Isolated init-lifecycle diagnostic channel — SEPARATE from @shared/logger.
//
// Purpose: capture the sparse set of agent init-lifecycle events (tab open,
// init-status transitions, AgentView mount/unmount, copilot ACP close / caps)
// into their OWN file, so they stay readable even during concurrent dev on
// other features and never pollute the main MMDD.log.
//
// This is diagnostic instrumentation for a specific investigation (copilot idle
// → pane stuck on "Starting agent…"); it is a pure addition and is intended to
// be removed once the root cause is proven. Do NOT build product behaviour on it.

let diagWriter: ((line: string) => void) | null = null;

export function setDiagWriter(writer: (line: string) => void) {
  diagWriter = writer;
}

/**
 * Write one structured, timestamped line to the diag channel. No level check —
 * every call is emitted (the channel is inherently sparse). No-op until a writer
 * is set (e.g. in the renderer / agent-server, where events are routed to main
 * via a `diag:`-tagged log seam instead of a direct writer).
 */
export function diag(event: string, fields?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} [diag] ${event}${fields ? ' ' + JSON.stringify(fields) : ''}`;
  diagWriter?.(line);
}
