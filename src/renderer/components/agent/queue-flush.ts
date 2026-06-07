/**
 * Pure decision logic for the agent input's one-at-a-time queue flush.
 *
 * Every user submission is enqueued (InputZone never sends directly); a single
 * effect drains the queue. The rule:
 *
 *   - While the agent is streaming, no message flushes — they wait.
 *   - When the agent is idle AND the flush is "armed" AND the queue is non-empty,
 *     flush exactly ONE message and DISARM.
 *   - Re-arm only when streaming actually (re)starts.
 *
 * The armed latch is what prevents the burst bug: after a flush, `isStreaming`
 * stays false until the dispatched send round-trips to a `status: streaming`
 * event. In that window the draining effect re-fires (the queue changed), and
 * without the latch it would drain the WHOLE queue at once instead of one per
 * streaming→idle cycle. Every dispatched message yields a streaming status
 * (even instant ones), so re-arming is guaranteed → the queue never stalls.
 *
 * This is a pure reducer so the latch behavior is unit-testable without React,
 * IPC, or timing. The component keeps `armed` in a ref, calls this on every
 * (isStreaming, queueLength) observation, stores the returned `armed`, and
 * performs the actual send side effect when `flush` is true.
 */
export interface FlushObservation {
  isStreaming: boolean;
  queueLength: number;
}

export interface FlushDecision {
  /** Next value of the armed latch. */
  armed: boolean;
  /** Whether the caller should dequeue + send exactly one message now. */
  flush: boolean;
}

export function reduceFlush(prevArmed: boolean, obs: FlushObservation): FlushDecision {
  // Streaming → never flush; (re)arm for the next idle transition.
  if (obs.isStreaming) return { armed: true, flush: false };
  // Idle + armed + something queued → flush one and disarm.
  if (prevArmed && obs.queueLength > 0) return { armed: false, flush: true };
  // Idle but disarmed (post-flush window) or empty → hold.
  return { armed: prevArmed, flush: false };
}
