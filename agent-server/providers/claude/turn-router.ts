/**
 * Pure turn-attribution state machine for claude's streaming-input persistent
 * session (Architecture B — see background-tasks#3 / streaming-input feature).
 *
 * In streaming-input mode ONE long-lived `sdkQuery` serves the whole session,
 * so a single consumer loop drains a generator that carries messages for MANY
 * turns: the user's foreground turns AND the SDK's auto-resume turns (emitted
 * after a backgrounded task settles). The SDK gives us NO field that maps a
 * message back to the user message that triggered it (Phase 0 spike: result
 * objects carry no originating-user backref). So we attribute by ORDER + a
 * couple of reliable wire signals.
 *
 * Spike-confirmed facts this machine relies on:
 *   - Turns are strictly serial: each turn (foreground OR auto-resume) opens
 *     with its own `system/init` and ends with exactly one `result`, and turns
 *     never interleave.
 *   - A foreground turn is one the USER pushed (a pending entry is waiting); an
 *     auto-resume turn is one the SDK started on its own (no pending entry).
 *
 * **Why pending-presence, NOT a task_notification counter** (this is the fix
 * for the real "stuck / ESC can't stop" bug): a backgrounded task that settles
 * does NOT always make the model auto-resume (it may stay silent). An earlier
 * design armed an "auto-resume expected" counter on every `task_notification`
 * and consumed it on the next `init`; when no auto-resume followed, the counter
 * drifted positive and STOLE the next genuine foreground turn's init → that
 * turn never got an active lane → its result was ignored → query() hung forever
 * (spinner stuck, interrupt() no-op because the SDK turn already ended). Keying
 * off `pendingPush` instead is drift-proof.
 *
 * Result origin is intentionally NOT used to match a result to a turn — there
 * is exactly one active turn at a time, so a result closes whatever is active.
 * (Origin still distinguishes lanes elsewhere only as a sanity input; matching
 * by "active turn" is what makes mis-guesses non-fatal.)
 *
 * PURE: takes the discriminating fields of each SDK message + current state,
 * returns next state + a routing `action`. The impure consumer
 * (createClaudeBackend) owns the real per-turn entries and applies actions.
 */

/** Minimal discriminator extracted from an SDK message — keeps this testable
 *  without constructing full SDK objects. */
export interface RouterInput {
  type: string; // SDKMessage.type
  /** msg.subtype when type === 'system' (e.g. 'init', 'task_started'). */
  systemSubtype?: string;
}

/** Which lane a message belongs to (whose send fn the consumer should use). */
export type Lane = 'foreground' | 'server' | 'task' | 'ignore';

export interface RouterAction {
  lane: Lane;
  /** Open a turn on the lane before routing (consume a pendingPush for
   *  foreground; mint a server turnId for server). */
  start?: boolean;
  /** Close the lane's active turn after routing. */
  close?: boolean;
}

export interface RouterState {
  /** Foreground user turns pushed but whose `system/init` hasn't arrived yet. */
  pendingPush: number;
  /** What kind of turn is currently being streamed (null between turns). */
  active: 'foreground' | 'server' | null;
}

export function createRouterState(): RouterState {
  return { pendingPush: 0, active: null };
}

/** Record that a user prompt was pushed into the input stream (its `init` is
 *  pending). Mutates and returns state for call-site convenience. */
export function notePush(state: RouterState): RouterState {
  state.pendingPush += 1;
  return state;
}

/**
 * Advance the state machine by one message. Mutates `state` in place (the
 * consumer holds one long-lived state object) and returns the routing action.
 */
export function routeMessage(state: RouterState, input: RouterInput): RouterAction {
  const { type, systemSubtype } = input;

  // ── Background-task system messages → task lane (turnId-less task_event).
  if (type === 'system' && systemSubtype && systemSubtype.startsWith('task_')) {
    return { lane: 'task' };
  }

  // ── Turn boundary: every turn (foreground or auto-resume) opens with init.
  //    A pending user push ⇒ foreground; none ⇒ the SDK auto-resumed ⇒ server.
  if (type === 'system' && systemSubtype === 'init') {
    if (state.pendingPush > 0) {
      state.pendingPush -= 1;
      state.active = 'foreground';
      return { lane: 'foreground', start: true };
    }
    state.active = 'server';
    return { lane: 'server', start: true };
  }

  // ── Result: closes whatever turn is currently active. There is exactly one
  //    active turn at a time, so we don't need (and must not rely on) origin to
  //    match — that's what makes an init mis-guess non-fatal instead of a hang.
  if (type === 'result') {
    if (state.active === 'foreground') { state.active = null; return { lane: 'foreground', close: true }; }
    if (state.active === 'server') { state.active = null; return { lane: 'server', close: true }; }
    return { lane: 'ignore' };
  }

  // ── Everything else (assistant / stream_event / user-tool_result / other
  //    system / rate_limit_event): route to the active turn's lane.
  if (state.active === 'foreground') return { lane: 'foreground' };
  if (state.active === 'server') return { lane: 'server' };
  return { lane: 'ignore' };
}
