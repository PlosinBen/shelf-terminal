import { log } from '@shared/logger';
import type { AgentQueueItem, TaskEvent } from '@shared/types';
import type { AgentEvent } from './types';

/**
 * Per-execution handler invoked when a `permission_request` event arrives for a
 * specific execution. The dispatcher routes by executionId so concurrent executions (e.g.
 * queued message flush mid-stream) never cross-contaminate each other's
 * permission flows.
 */
export type PermissionHandler = (toolUseId: string, toolName: string, input: Record<string, unknown>) => void;

/**
 * Pure event dispatcher — no I/O. Routes raw parsed events from agent-server
 * stdout to one of two destinations, by type:
 *   - **Session state/content** (execution-less capabilities, message / stream /
 *     error) → the session-level
 *     `onSessionEvent` sink, delivered by tabId, NOT through the per-execution
 *     generator — so late-at-the-seam content is never dropped as "unknown execution".
 *   - **Execution control** (status, permission_request, plan, execution-bound capabilities,
 *     picker, auth) → the per-execution AsyncGenerator by `executionId` envelope (drives
 *     execution-end / busy-idle / `query()` resolution).
 * So `executionId` is the seam token for STATUS/lifecycle, not for content. Session-
 * scoped sidebands (task_event / queue / skills_reloaded) are routed by type
 * before the executionId check. Splitting this out of the ChildProcess wrapper makes
 * it unit-testable without mocking the subprocess boundary. See executionId-scoping.
 */
export interface ExecutionDispatcher {
  /** Feed one already-JSON-parsed wire message into the dispatcher. */
  feed(msg: unknown): void;
  /**
   * Register a execution so events tagged with `executionId` get routed to the returned
   * AsyncGenerator. MUST be called before the corresponding `send` reaches
   * agent-server, otherwise early events would be dropped as "unknown execution".
   * Generator ends after the first `state:'idle'` event (plus any tail events
   * already buffered).
   */
  registerExecution(executionId: string, permissionHandler: PermissionHandler): AsyncGenerator<AgentEvent>;
  /** Wait for `{type:'ready'}`. Resolves false on timeout. */
  awaitReady(timeoutMs?: number): Promise<boolean>;
  /**
   * Register a callback to receive a one-shot RPC response keyed by
   * `<expectedType>:<requestId>`. Used for lifecycle round-trips
   * (capabilities / credential_* / slash_result).
   */
  onResponse(requestId: string, expectedType: string, handler: (payload: any) => void): void;
  /**
   * Fail-loud on a lost provider execution (dispatch-layering): the session's
   * exec died / went unresponsive, so every in-flight execution is dropped. Each
   * execution's generator yields a terminal `error` then ends (idle) — so main's
   * sendMessage surfaces the error to the renderer, unsticks the spinner, and its
   * `finally` clears pending permissions. Called before the dispatcher reconnects.
   */
  failAllExecutions(errorMessage: string): void;
}

interface ExecutionState {
  events: AgentEvent[];
  done: boolean;
  resolve?: () => void;
  permissionHandler: PermissionHandler;
}

export function createExecutionDispatcher(
  parseRemoteMessage: (msg: any) => AgentEvent | null,
  // Session-level sink for background-task events. These carry NO executionId
  // (decoupled from busy-state) so they're routed here BEFORE the per-execution
  // executionId check — otherwise they'd hit the "missing executionId, dropping" branch.
  // Defaults to a no-op so non-background callers (tests, providers without
  // background support) need not pass it.
  onTaskEvent?: (ev: TaskEvent) => void,
  // Sink for a server-initiated execution (auto-resume prose after a background
  // task finishes). On `execution_started` the dispatcher registers the
  // provider-minted executionId and hands the caller the execution's AsyncGenerator to
  // drain into the renderer. Permissionless (noop handler) — the auto-resume
  // path doesn't route tool permissions in v1. See background-tasks#2.
  onServerExecution?: (executionId: string, events: AsyncGenerator<AgentEvent>) => void,
  // Session-level sink for the server-owned send-queue snapshot. Like
  // task_event, these carry NO executionId (the queue is session-scoped) so they're
  // routed here BEFORE the per-execution executionId check. See message-queue-ownership.
  onQueue?: (items: AgentQueueItem[]) => void,
  // Session-level sink for an app-skill reload result (executionId-less, like
  // task_event/queue). Routed before the executionId check. See skill-reload feedback.
  onSkillsReloaded?: (ok: boolean, error?: string) => void,
  // Session-level sink for DISPLAY events (message/stream/error) that we deliver
  // by tabId instead of through the per-execution generator — so late-at-the-seam
  // content is never dropped as "unknown execution". executionId stays only for status /
  // control. Routed before the executionId check. Wired type-by-type (Phase 2);
  // unused until a feed() branch calls it. See executionId-scoping.
  onSessionEvent?: (event: AgentEvent) => void,
): ExecutionDispatcher {
  const executions = new Map<string, ExecutionState>();
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
    // execution — these are out-of-band RPCs, not part of a query execution.
    if (m?.requestId && m?.type) {
      const key = `${m.type}:${m.requestId}`;
      const handler = responseHandlers.get(key);
      if (handler) {
        responseHandlers.delete(key);
        handler(m);
        return;
      }
    }

    // Background task events: executionId-less by design (a backgrounded task
    // outlives its execution). Route to the session-level sink BEFORE the executionId
    // check so they don't fall into the "missing executionId, dropping" branch.
    // This is the fix for the "event for unknown execution … dropping" bug when the
    // model backgrounds work mid-execution. See background-tasks#2.
    if (m?.type === 'task_event') {
      onTaskEvent?.({ kind: m.kind, task: m.task, tasks: m.tasks });
      return;
    }

    // App-skill reload result: session-level (executionId-less), like task_event.
    // Route to the session sink before the executionId check below.
    if (m?.type === 'skills_reloaded') {
      onSkillsReloaded?.(!!m.ok, typeof m.error === 'string' ? m.error : undefined);
      return;
    }

    // Provider-native mode/config updates can arrive after the execution that
    // triggered them has settled (for example a native slash command or ACP
    // config update). They describe session truth, so execution-less capability
    // updates use the tab/session sink instead of being dropped by the execution
    // guard below. requestId-keyed probes were consumed by the RPC branch above;
    // execution-bound canonical updates keep their existing generator path.
    if (onSessionEvent && m?.type === 'capabilities' && !m?.requestId && !m?.executionId) {
      const ev = parseRemoteMessage(m);
      if (ev) onSessionEvent(ev);
      else log.info('agent-remote', 'session capabilities event unparseable, dropped');
      return;
    }

    // DISPLAY events delivered session-scoped (Phase 2 executionId-scoping): route
    // by tabId via the sink, BEFORE the executionId check, so late-at-the-seam content
    // is never dropped as "unknown execution". executionId stays only for status/control
    // (the per-execution generator now carries only status/plan/capabilities/picker/
    // auth + permission routing). Only diverts when a sink is wired — callers
    // without one (tests) keep the legacy per-execution-generator path. `message` and
    // `stream` move together so a stream chunk and its msgId-paired finalize are
    // never split across the two delivery paths.
    if (onSessionEvent && (m?.type === 'error' || m?.type === 'message' || m?.type === 'stream')) {
      const ev = parseRemoteMessage(m);
      if (ev) {
        // Session-scoped display delivery (tool results / replies / streams land
        // here, NOT via the per-execution generator). Debug trace closes the gap
        // between wire-rx and the renderer: if a tool result shows in wire-rx but
        // never here, it's being dropped at parse; if here but not rendered, the
        // renderer dropped it. See connection-wedge trace.
        log.debug('agent-remote', `session-event type=${m.type}${m.msgType ? ` msgType=${m.msgType}` : ''}`);
        onSessionEvent(ev);
      } else {
        // Display content that parseRemoteMessage couldn't build (unknown
        // msgType / malformed) — real content vanishing. Never silent.
        log.info('agent-remote', `session display event unparseable, dropped: type=${m.type}${m.msgType ? `/${m.msgType}` : ''}`);
      }
      return;
    }

    // Account-status refresh: a `status` with NO executionId is session-scoped (e.g.
    // copilot's post-execution premium-credit update, fetched out-of-band since ACP has
    // no usage_update). Route to the session sink BEFORE the executionId check — a normal
    // execution status carries a executionId and still flows to its per-execution generator below.
    if (onSessionEvent && m?.type === 'status' && !m?.executionId) {
      const ev = parseRemoteMessage(m);
      if (ev) onSessionEvent(ev);
      else log.info('agent-remote', 'session status event unparseable, dropped');
      return;
    }

    // Interactive login events: session-level (executionId-less) — the login runs
    // outside any execution (triggered by an IPC command, not a `send`). Route to the
    // session sink before the executionId check so they aren't dropped as "unknown
    // execution". See features copilot-device-login.
    if (m?.type === 'auth_login_prompt' || m?.type === 'auth_login_done') {
      const ev = parseRemoteMessage(m);
      if (ev) onSessionEvent?.(ev);
      else log.info('agent-remote', `login event unparseable, dropped: type=${m.type}`);
      return;
    }

    // Send-queue snapshot: session-level (executionId-less), like task_event. Route
    // to the session sink before the executionId check below.
    if (m?.type === 'queue') {
      if (Array.isArray(m.items)) {
        onQueue?.(m.items as AgentQueueItem[]);
      } else {
        // Malformed snapshot — log rather than silently treating as empty (an
        // empty snapshot would wrongly drop the renderer's queued chips).
        log.info('agent-remote', `queue snapshot with non-array items, ignoring: ${typeof m.items}`);
      }
      return;
    }

    // Server-initiated execution: the provider opened a execution we never sent a `send`
    // for (auto-resume prose). Register it NOW — synchronously, before the next
    // feed() delivers its content — so those events have a destination instead
    // of hitting the "unknown execution" drop below. registerExecution sets execution state
    // synchronously, so the just-handed generator is safe to drain lazily.
    if (m?.type === 'execution_started' && typeof m.executionId === 'string' && m.executionId) {
      if (executions.has(m.executionId)) return; // dup announcement — ignore
      const events = registerExecution(m.executionId, () => {});
      onServerExecution?.(m.executionId, events);
      return;
    }

    // Per-execution events: route by executionId envelope. With a session sink wired,
    // ONLY status / control reaches here — display content (message/stream/error)
    // was already delivered session-scoped above, so it can never be dropped by
    // the executionId guards below. executionId is thus the seam token for STATUS/lifecycle
    // (execution-end, busy/idle, query() resolution), not for content. See executionId-scoping.
    const executionId: string | undefined = m?.executionId;
    if (!executionId) {
      log.info('agent-remote', `non-lifecycle event missing executionId, dropping: type=${m?.type}`);
      return;
    }
    const execution = executions.get(executionId);
    if (!execution) {
      // Event for a execution that's already been deregistered. Most commonly a
      // tail `status:'idle'` (the provider's finally block emits a second idle).
      // Harmless — log at info level so it shows up if debugging cross-execution
      // leaks but doesn't spam in normal operation. (Display content no longer
      // reaches here, so this is never a lost reply/tool-result.)
      log.info('agent-remote', `event for unknown execution ${executionId}, dropping: type=${m?.type}`);
      return;
    }

    // Permission requests don't go on the event queue; they fire a per-execution
    // callback that initiates the canUseTool roundtrip.
    if (m.type === 'permission_request') {
      execution.permissionHandler(m.toolUseId, m.toolName, m.input ?? {});
      return;
    }

    const event = parseRemoteMessage(m);
    if (!event) {
      // parseRemoteMessage couldn't build an AgentEvent (unknown type / unknown
      // msgType / malformed payload). This is real execution content being dropped —
      // log it so an unrecognized wire shape is visible instead of silently
      // vanishing (e.g. "tool result not showing").
      log.info('agent-remote', `execution ${executionId}: unparseable message dropped: type=${m?.type}${m?.msgType ? `/${m.msgType}` : ''}`);
      return;
    }
    execution.events.push(event);
    if (event.type === 'status' && (event.payload as any).state === 'idle') {
      execution.done = true;
      log.debug('agent-remote', `execution ${executionId} got idle → ending`);
    }
    execution.resolve?.();
  }

  function registerExecution(
    executionId: string,
    permissionHandler: PermissionHandler,
  ): AsyncGenerator<AgentEvent> {
    // CRITICAL: register state synchronously, BEFORE returning the generator.
    // Async-generator bodies don't run until the consumer calls `.next()` —
    // if we put `executions.set()` inside the generator body, the execution wouldn't
    // be registered until the first iteration, leaving a race window where
    // agent-server's early events get dropped as "unknown execution".
    const state: ExecutionState = { events: [], done: false, permissionHandler };
    executions.set(executionId, state);
    log.debug('agent-remote', `execution registered ${executionId} (live executions=${executions.size})`);

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
        executions.delete(executionId);
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

  function failAllExecutions(errorMessage: string): void {
    for (const state of executions.values()) {
      // Error first (rendered as an error line), then idle so the generator ends.
      state.events.push({ type: 'error', error: errorMessage } as AgentEvent);
      state.events.push({ type: 'status', payload: { state: 'idle' } } as AgentEvent);
      state.done = true;
      state.resolve?.();
    }
  }

  return { feed, registerExecution, awaitReady, onResponse, failAllExecutions };
}
