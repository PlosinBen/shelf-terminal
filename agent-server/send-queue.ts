import type { AgentQueueItem } from '@shared/types';
import { QUEUE_CANCEL as C, type QueueCancelResult } from '@shared/agent-queue-cancel';

/**
 * Server-owned send queue (Architecture: queue lives in agent-server, the
 * execution plane that serializes executions). The client eager-sends every
 * submission; this owns排序 + 釋放時機 and emits a snapshot the renderer
 * mirrors. See agent-core#7.
 *
 * Why serialize at all (the original `sendChain` reason): concurrent execution
 * handlers race on the provider backend's module-level state (activeExecutionSend /
 * abortController / activeQuery / lastSessionId). One execution runs at a time.
 *
 * Pure factory (no stdin/stdout / no provider imports) so the enqueue / pump /
 * cancel / clear / snapshot logic is unit-testable without a real backend.
 */
export interface QueuedSend {
  /** Main-minted per-execution id. Present for real sends; used to emit a terminal
   *  idle if the send is dropped before running (else main's per-execution generator
   *  hangs forever). */
  executionId?: string;
  /** Factory message id for queue receipts/projection. Control-only sends omit
   *  it and are still serialized without appearing in the snapshot. */
  clientMsgId?: string;
}

export interface SendQueueDeps<T extends QueuedSend> {
  /** Run one send to completion (the provider execution). */
  handle: (msg: T) => Promise<void>;
  /** Push the full ordered snapshot of in-flight client sends to the client. */
  emitSnapshot: (items: AgentQueueItem[]) => void;
  /** Emit a terminal idle for a dropped queued send's executionId so the main-side
   *  per-execution generator (registered before the send was sent) doesn't hang. */
  terminateExecution: (executionId: string) => void;
  /** A handle() that threw must STILL end the execution (idle), or the renderer —
   *  already streaming — wedges forever. */
  onHandleError: (msg: T, err: unknown) => void;
  /** Diagnostic for a cancel/clear edge that isn't a clean queue removal (never
   *  silent). `reason`: 'cancel-running' = the id is the execution already running
   *  (benign race — can't un-run); 'cancel-unknown' = no such id anywhere. */
  onAnomaly?: (reason: 'cancel-running' | 'cancel-unknown', clientMsgId: string) => void;
}

export interface SendQueue<T extends QueuedSend> {
  /** Eager-sent submission arrives → queue it + pump. */
  enqueue(msg: T): void;
  /** Drop a specific not-yet-running send by clientMsgId. No-op if running/unknown. */
  cancel(clientMsgId: string): QueueCancelResult;
  /** Drop waiting messages only; use stop() to coordinate provider interruption and controls. */
  clear(): void;
  /** Cancel unstarted controls and waiting messages; hold dispatch during provider stop. */
  stop(interrupt: () => Promise<void>): Promise<void>;
  /** Test/diagnostic introspection. */
  snapshot(): AgentQueueItem[];
  /** Reserve one independent control slot; never projected as a message. */
  runControl(run: () => Promise<void>, defer: boolean): Promise<void>;
  /** An unconfirmed mutation must not allow queued work to run with unknown settings. */
  block(): void;
}

export function createSendQueue<T extends QueuedSend>(deps: SendQueueDeps<T>): SendQueue<T> {
  const queue: T[] = [];
  let processing = false;
  let runningClientMsgId: string | undefined;
  let control: { run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void; started: boolean; scheduled: boolean; defer: boolean } | undefined;
  let blocked = false;
  let stopping: Promise<void> | undefined;

  function snapshot(): AgentQueueItem[] {
    const items: AgentQueueItem[] = [];
    if (runningClientMsgId !== undefined) items.push({ clientMsgId: runningClientMsgId, state: 'running' });
    for (const m of queue) {
      if (m.clientMsgId !== undefined) items.push({ clientMsgId: m.clientMsgId, state: 'queued' });
    }
    return items;
  }
  const emit = () => deps.emitSnapshot(snapshot());
  const terminate = (msg: T) => { if (msg.executionId) deps.terminateExecution(msg.executionId); };

  function pump(): void {
    if (blocked || stopping) return;
    if (control) {
      if (!control.scheduled && (!processing || !control.defer)) {
        const current = control;
        current.scheduled = true;
        Promise.resolve().then(() => {
          if (control !== current) return; // Stop cancelled this control before invocation.
          current.started = true;
          return current.run();
        }).then(current.resolve, current.reject).finally(() => {
          if (control === current) control = undefined;
          pump();
        });
      }
      return;
    }
    if (processing) return;
    const next = queue.shift();
    if (!next) {
      // Drain-to-empty: clear the running marker + emit the empty snapshot once.
      if (runningClientMsgId !== undefined) { runningClientMsgId = undefined; emit(); }
      return;
    }
    processing = true;
    runningClientMsgId = next.clientMsgId;
    emit();
    Promise.resolve()
      .then(() => deps.handle(next))
      .catch((err) => deps.onHandleError(next, err))
      .finally(() => {
        // A control may now own the boundary. Clear the completed message's
        // running marker before waiting, without projecting the control itself.
        processing = false;
        runningClientMsgId = undefined;
        emit();
        pump();
      });
  }

  function clear(): void {
    if (queue.length === 0) return;
    const dropped = queue.splice(0, queue.length);
    for (const m of dropped) terminate(m);
    emit();
  }

  return {
    stop(interrupt) {
      if (stopping) return stopping;
      // Establish the barrier before interrupt can settle the active execution.
      stopping = Promise.resolve().then(interrupt).finally(() => {
        stopping = undefined;
        pump();
      });
      clear();
      if (control && !control.started) {
        const cancelled = control;
        control = undefined;
        cancelled.reject(new Error('Session stopped; pending setting was not applied'));
      }
      return stopping;
    },
    runControl(run, defer) {
      if (stopping) return Promise.reject(new Error('Session is stopping; setting was not applied'));
      if (blocked) return Promise.reject(new Error('Session configuration is uncertain; reconnect before continuing'));
      if (control) return Promise.reject(new Error('A session configuration request is already pending'));
      return new Promise<void>((resolve, reject) => { control = { run, resolve, reject, started: false, scheduled: false, defer }; pump(); });
    },
    block() { blocked = true; },
    enqueue(msg: T): void {
      queue.push(msg);
      // Show the new chip immediately when busy (pump won't emit until the
      // current execution ends). When idle, skip — pump emits [running] right away,
      // avoiding a one-tick 'queued' flash for the common idle send.
      if (processing) emit();
      pump();
    },
    cancel(clientMsgId: string): QueueCancelResult {
      const i = queue.findIndex((m) => m.clientMsgId === clientMsgId);
      if (i < 0) {
        // Queue authority decides the outcome; a local cancellation intent cannot
        // remove content that may already be running.
        deps.onAnomaly?.(clientMsgId === runningClientMsgId ? 'cancel-running' : 'cancel-unknown', clientMsgId);
        return { status: clientMsgId === runningClientMsgId ? C.STATUS.RUNNING : C.STATUS.NOT_FOUND };
      }
      const [removed] = queue.splice(i, 1);
      terminate(removed);
      emit();
      return { status: C.STATUS.CANCELLED };
    },
    clear,
    snapshot,
  };
}
