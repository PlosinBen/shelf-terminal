/**
 * Pure turn-attribution state machine for claude's streaming-input persistent
 * session (Architecture B — see .agent DECISIONS / streaming-input feature).
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
 *   - Each turn (foreground OR auto-resume) opens with its own `system/init`.
 *   - Foreground turns never interleave with each other (serial agent loop).
 *   - An auto-resume turn is ALWAYS immediately preceded by a `task_notification`
 *     (sequence: task_updated → task_notification → init → assistant → result).
 *   - A foreground turn's `result` has NO `origin`; an auto-resume turn's
 *     `result` has `origin.kind === 'task-notification'`.
 *   - `system/init` is byte-identical between foreground and auto-resume, so it
 *     cannot self-identify — hence the `task_notification`-armed latch below.
 *
 * This module is PURE: it takes the discriminating fields of each SDK message
 * and the current state, and returns the next state plus a routing `action`.
 * The impure consumer (createClaudeBackend) owns the real per-turn entries
 * (turn-bound send fns, block-id maps, query() resolvers) and applies actions.
 */

/** Minimal discriminator extracted from an SDK message — keeps this testable
 *  without constructing full SDK objects. */
export interface RouterInput {
  type: string; // SDKMessage.type
  /** msg.subtype when type === 'system' (e.g. 'init', 'task_started', 'status'). */
  systemSubtype?: string;
  /** msg.origin?.kind when type === 'result' ('task-notification' marks auto-resume). */
  resultOrigin?: string;
}

/** Which lane a message belongs to (whose send fn the consumer should use). */
export type Lane = 'foreground' | 'server' | 'task' | 'ignore';

export interface RouterAction {
  lane: Lane;
  /** Open a turn on the lane before routing (consume a pendingPush for
   *  foreground; mint a server turnId for server). */
  start?: boolean;
  /** Close the lane's active turn after routing (foreground: resolve query() +
   *  the result case already emitted idle; server: emit idle for the sub-turn). */
  close?: boolean;
}

export interface RouterState {
  /** Foreground user turns pushed but whose `system/init` hasn't arrived yet. */
  pendingPush: number;
  hasActiveForeground: boolean;
  hasActiveServer: boolean;
  /** Count of settled tasks whose auto-resume turn hasn't opened yet. Bumped on
   *  each `task_notification`, consumed by the next `system/init`. */
  autoResumeArmed: number;
}

export function createRouterState(): RouterState {
  return { pendingPush: 0, hasActiveForeground: false, hasActiveServer: false, autoResumeArmed: 0 };
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
  const { type, systemSubtype, resultOrigin } = input;

  // ── Background-task system messages → task lane (turnId-less task_event).
  //    task_notification additionally arms the next init as an auto-resume.
  if (type === 'system' && systemSubtype && systemSubtype.startsWith('task_')) {
    if (systemSubtype === 'task_notification') state.autoResumeArmed += 1;
    return { lane: 'task' };
  }

  // ── Turn boundary: every turn (foreground or auto-resume) opens with init.
  if (type === 'system' && systemSubtype === 'init') {
    if (state.autoResumeArmed > 0) {
      state.autoResumeArmed -= 1;
      state.hasActiveServer = true;
      return { lane: 'server', start: true };
    }
    // Foreground turn starts — consume a pending push if we have one. (Guard
    // against underflow: a stray init with no pending push still opens a
    // foreground turn so its content isn't dropped, but doesn't go negative.)
    if (state.pendingPush > 0) state.pendingPush -= 1;
    state.hasActiveForeground = true;
    return { lane: 'foreground', start: true };
  }

  // ── Result: closes whichever turn is active. origin is the ground-truth
  //    discriminator (auto-resume carries origin='task-notification').
  if (type === 'result') {
    if (resultOrigin === 'task-notification') {
      if (state.hasActiveServer) {
        state.hasActiveServer = false;
        return { lane: 'server', close: true };
      }
      return { lane: 'ignore' };
    }
    if (state.hasActiveForeground) {
      state.hasActiveForeground = false;
      return { lane: 'foreground', close: true };
    }
    return { lane: 'ignore' };
  }

  // ── Everything else (assistant / stream_event / user-tool_result / other
  //    system like 'status'/'compact_boundary' / rate_limit_event): route to
  //    the active lane. Server takes precedence while an auto-resume is open.
  if (state.hasActiveServer) return { lane: 'server' };
  if (state.hasActiveForeground) return { lane: 'foreground' };
  return { lane: 'ignore' };
}
