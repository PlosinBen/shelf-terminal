// Per-host dispatcher process (dispatch-layering, group D). A THIN broker between
// main and the per-session exec procs: it multiplexes main's N sids onto N exec
// procs (`sid → exec-proc`, via the session-registry generalized to hold child
// handles), relays streams opaquely, holds the model cache, and runs two-tier
// health + supervision. It deliberately imports NO provider / SDK modules (those
// live in exec.ts, loaded only in the exec role) so this process stays thin.
//
// Built incrementally: D1 = role-split entrypoint only (this stub). D2 = relay +
// open/close_session. D3 = main-side wiring. D4 = two-tier health + supervisor.
// See the feature note.
export function runDispatcher(): void {
  // Not reachable until D3 wires main to spawn `--role=dispatcher`. Fail loud if
  // something invokes it early, rather than silently idling.
  process.stderr.write('[agent-server] --role=dispatcher not yet implemented (lands in D2)\n');
  process.exit(1);
}
