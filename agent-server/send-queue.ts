import type { AgentQueueItem } from '@shared/types';

/**
 * Server-owned send queue (Architecture: queue lives in agent-server, the
 * execution plane that serializes turns). The client eager-sends every
 * submission; this owns排序 + 釋放時機 and emits a snapshot the renderer
 * mirrors. See .agent/features/message-queue-ownership.md.
 *
 * Why serialize at all (the original `sendChain` reason): concurrent turn
 * handlers race on the provider backend's module-level state (currentSend /
 * abortController / activeQuery / lastSessionId). One turn runs at a time.
 *
 * Pure factory (no stdin/stdout / no provider imports) so the enqueue / pump /
 * cancel / clear / snapshot logic is unit-testable without a real backend.
 */
export interface QueuedSend {
  /** Main-minted per-turn id. Present for real sends; used to emit a terminal
   *  idle if the send is dropped before running (else main's per-turn generator
   *  hangs forever). */
  turnId?: string;
  /** Renderer-minted correlation key. Absent for internal sends (telegram
   *  bridge) — those are still serialized but omitted from the snapshot. */
  clientMsgId?: string;
}

export interface SendQueueDeps<T extends QueuedSend> {
  /** Run one send to completion (the provider turn). */
  handle: (msg: T) => Promise<void>;
  /** Push the full ordered snapshot of in-flight client sends to the client. */
  emitSnapshot: (items: AgentQueueItem[]) => void;
  /** Emit a terminal idle for a dropped queued send's turnId so the main-side
   *  per-turn generator (registered before the send was sent) doesn't hang. */
  terminateTurn: (turnId: string) => void;
  /** A handle() that threw must STILL end the turn (idle), or the renderer —
   *  already streaming — wedges forever. */
  onHandleError: (msg: T, err: unknown) => void;
}

export interface SendQueue<T extends QueuedSend> {
  /** Eager-sent submission arrives → queue it + pump. */
  enqueue(msg: T): void;
  /** Drop a specific not-yet-running send by clientMsgId. No-op if running/unknown. */
  cancel(clientMsgId: string): void;
  /** Drop every waiting send (ESC / stop). The running turn is interrupted
   *  separately by the caller (backend.stop). */
  clear(): void;
  /** Test/diagnostic introspection. */
  snapshot(): AgentQueueItem[];
}

export function createSendQueue<T extends QueuedSend>(deps: SendQueueDeps<T>): SendQueue<T> {
  const queue: T[] = [];
  let processing = false;
  let runningClientMsgId: string | undefined;

  function snapshot(): AgentQueueItem[] {
    const items: AgentQueueItem[] = [];
    if (runningClientMsgId !== undefined) items.push({ clientMsgId: runningClientMsgId, state: 'running' });
    for (const m of queue) {
      if (m.clientMsgId !== undefined) items.push({ clientMsgId: m.clientMsgId, state: 'queued' });
    }
    return items;
  }
  const emit = () => deps.emitSnapshot(snapshot());
  const terminate = (msg: T) => { if (msg.turnId) deps.terminateTurn(msg.turnId); };

  function pump(): void {
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
        // Don't reset runningClientMsgId here — pump's drain branch needs to see
        // the still-set value to know it must emit the final empty snapshot
        // (it compares `runningClientMsgId !== undefined`). pump clears it.
        processing = false;
        pump();
      });
  }

  return {
    enqueue(msg: T): void {
      queue.push(msg);
      // Show the new chip immediately when busy (pump won't emit until the
      // current turn ends). When idle, skip — pump emits [running] right away,
      // avoiding a one-tick 'queued' flash for the common idle send.
      if (processing) emit();
      pump();
    },
    cancel(clientMsgId: string): void {
      const i = queue.findIndex((m) => m.clientMsgId === clientMsgId);
      if (i < 0) return;
      const [removed] = queue.splice(i, 1);
      terminate(removed);
      emit();
    },
    clear(): void {
      if (queue.length === 0) return;
      const dropped = queue.splice(0, queue.length);
      for (const m of dropped) terminate(m);
      emit();
    },
    snapshot,
  };
}
