import { log } from '@shared/logger';
import type { TaskEvent } from '@shared/types';
import type { AgentEvent } from './types';

/**
 * Per-turn handler invoked when a `permission_request` event arrives for a
 * specific turn. The dispatcher routes by turnId so concurrent turns (e.g.
 * queued message flush mid-stream) never cross-contaminate each other's
 * permission flows.
 */
export type PermissionHandler = (toolUseId: string, toolName: string, input: Record<string, unknown>) => void;

/**
 * Pure event dispatcher — no I/O. Feeds raw parsed events from agent-server
 * stdout into per-turn AsyncGenerators by `turnId` envelope. Splitting this
 * out of the ChildProcess wrapper makes it unit-testable without mocking the
 * subprocess boundary.
 */
export interface TurnDispatcher {
  /** Feed one already-JSON-parsed wire message into the dispatcher. */
  feed(msg: unknown): void;
  /**
   * Register a turn so events tagged with `turnId` get routed to the returned
   * AsyncGenerator. MUST be called before the corresponding `send` reaches
   * agent-server, otherwise early events would be dropped as "unknown turn".
   * Generator ends after the first `state:'idle'` event (plus any tail events
   * already buffered).
   */
  registerTurn(turnId: string, permissionHandler: PermissionHandler): AsyncGenerator<AgentEvent>;
  /** Wait for `{type:'ready'}`. Resolves false on timeout. */
  awaitReady(timeoutMs?: number): Promise<boolean>;
  /**
   * Register a callback to receive a one-shot RPC response keyed by
   * `<expectedType>:<requestId>`. Used for lifecycle round-trips
   * (capabilities / credential_* / slash_result).
   */
  onResponse(requestId: string, expectedType: string, handler: (payload: any) => void): void;
}

interface TurnState {
  events: AgentEvent[];
  done: boolean;
  resolve?: () => void;
  permissionHandler: PermissionHandler;
}

export function createTurnDispatcher(
  parseRemoteMessage: (msg: any) => AgentEvent | null,
  // Session-level sink for background-task events. These carry NO turnId
  // (decoupled from busy-state) so they're routed here BEFORE the per-turn
  // turnId check — otherwise they'd hit the "missing turnId, dropping" branch.
  // Defaults to a no-op so non-background callers (tests, providers without
  // background support) need not pass it.
  onTaskEvent?: (ev: TaskEvent) => void,
  // Sink for a server-initiated turn (auto-resume prose after a background
  // task finishes). On `turn_started` the dispatcher registers the
  // provider-minted turnId and hands the caller the turn's AsyncGenerator to
  // drain into the renderer. Permissionless (noop handler) — the auto-resume
  // path doesn't route tool permissions in v1. See DECISIONS #69.
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
): TurnDispatcher {
  const turns = new Map<string, TurnState>();
  const responseHandlers = new Map<string, (payload: any) => void>();
  let readyResolve: ((ok: boolean) => void) | null = null;

  function feed(parsed: unknown): void {
    const m = parsed as any;

    // Lifecycle: ready signal — fires once when agent-server boots.
    if (m?.type === 'ready') {
      readyResolve?.(true);
      readyResolve = null;
      return;
    }

    // Lifecycle: requestId-keyed responses (capabilities / credential_* /
    // slash_result). Routed by `<type>:<requestId>` independent of any
    // turn — these are out-of-band RPCs, not part of a query turn.
    if (m?.requestId && m?.type) {
      const key = `${m.type}:${m.requestId}`;
      const handler = responseHandlers.get(key);
      if (handler) {
        responseHandlers.delete(key);
        handler(m);
        return;
      }
    }

    // Background task events: turnId-less by design (a backgrounded task
    // outlives its turn). Route to the session-level sink BEFORE the turnId
    // check so they don't fall into the "missing turnId, dropping" branch.
    // This is the fix for the "event for unknown turn … dropping" bug when the
    // model backgrounds work mid-turn. See DECISIONS #69.
    if (m?.type === 'task_event') {
      onTaskEvent?.({ kind: m.kind, task: m.task, tasks: m.tasks });
      return;
    }

    // Server-initiated turn: the provider opened a turn we never sent a `send`
    // for (auto-resume prose). Register it NOW — synchronously, before the next
    // feed() delivers its content — so those events have a destination instead
    // of hitting the "unknown turn" drop below. registerTurn sets turn state
    // synchronously, so the just-handed generator is safe to drain lazily.
    if (m?.type === 'turn_started' && typeof m.turnId === 'string' && m.turnId) {
      if (turns.has(m.turnId)) return; // dup announcement — ignore
      const events = registerTurn(m.turnId, () => {});
      onServerTurn?.(m.turnId, events);
      return;
    }

    // Per-turn events: route by turnId envelope.
    const turnId: string | undefined = m?.turnId;
    if (!turnId) {
      log.info('agent-remote', `non-lifecycle event missing turnId, dropping: type=${m?.type}`);
      return;
    }
    const turn = turns.get(turnId);
    if (!turn) {
      // Event for a turn that's already been deregistered. Most commonly a
      // tail event after the first `state:'idle'` (e.g. provider's finally
      // block emits a second idle). Harmless — log at info level so it
      // shows up if debugging cross-turn leaks but doesn't spam in normal
      // operation.
      log.info('agent-remote', `event for unknown turn ${turnId}, dropping: type=${m?.type}`);
      return;
    }

    // Permission requests don't go on the event queue; they fire a per-turn
    // callback that initiates the canUseTool roundtrip.
    if (m.type === 'permission_request') {
      turn.permissionHandler(m.toolUseId, m.toolName, m.input ?? {});
      return;
    }

    const event = parseRemoteMessage(m);
    if (!event) {
      // parseRemoteMessage couldn't build an AgentEvent (unknown type / unknown
      // msgType / malformed payload). This is real turn content being dropped —
      // log it so an unrecognized wire shape is visible instead of silently
      // vanishing (e.g. "tool result not showing").
      log.info('agent-remote', `turn ${turnId}: unparseable message dropped: type=${m?.type}${m?.msgType ? `/${m.msgType}` : ''}`);
      return;
    }
    turn.events.push(event);
    if (event.type === 'status' && (event.payload as any).state === 'idle') {
      turn.done = true;
    }
    turn.resolve?.();
  }

  function registerTurn(
    turnId: string,
    permissionHandler: PermissionHandler,
  ): AsyncGenerator<AgentEvent> {
    // CRITICAL: register state synchronously, BEFORE returning the generator.
    // Async-generator bodies don't run until the consumer calls `.next()` —
    // if we put `turns.set()` inside the generator body, the turn wouldn't
    // be registered until the first iteration, leaving a race window where
    // agent-server's early events get dropped as "unknown turn".
    const state: TurnState = { events: [], done: false, permissionHandler };
    turns.set(turnId, state);

    async function* drain(): AsyncGenerator<AgentEvent> {
      try {
        while (!state.done) {
          if (state.events.length > 0) {
            yield state.events.shift()!;
          } else {
            await new Promise<void>((r) => { state.resolve = r; });
          }
        }
        // Drain any tail events that landed alongside / after the idle.
        while (state.events.length > 0) {
          yield state.events.shift()!;
        }
      } finally {
        turns.delete(turnId);
      }
    }
    return drain();
  }

  function awaitReady(timeoutMs = 10000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      readyResolve = resolve;
      setTimeout(() => {
        if (readyResolve === resolve) {
          readyResolve = null;
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  function onResponse(requestId: string, expectedType: string, handler: (payload: any) => void): void {
    responseHandlers.set(`${expectedType}:${requestId}`, handler);
  }

  return { feed, registerTurn, awaitReady, onResponse };
}
