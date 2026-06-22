import type { AgentFile, AgentQueueItem } from '../shared/types';

/**
 * Pure reconcile logic for the server-owned send queue (renderer side).
 *
 * The renderer eager-sends every submission and optimistically shows it as a
 * "queued" chip. agent-server owns the authoritative queue and emits a full
 * ordered snapshot (AgentQueueItem[]) on every change. This function folds a
 * snapshot into the renderer's optimistic state, producing:
 *   - the next chip list (what's still waiting), and
 *   - the items to PROMOTE into the timeline now (their turn started running).
 *
 * Split into a pure function so the reconcile rules are unit-testable without
 * React / IPC / DOM (no jsdom in this project). See agentTabStore for wiring
 * and .agent/features/message-queue-ownership.md for the design.
 *
 * Promotion mechanism: an item shown as `state:'running'` in the snapshot is
 * the turn agent-server is actively processing → the renderer turns its chip
 * into a real timeline user bubble (matching CLI behaviour: a queued message
 * becomes "your message" once it runs). The `promoted` set dedups so repeated
 * snapshots (the running item lingers until it completes) promote only once.
 *
 * `confirmed` disambiguates the "absent from snapshot" case:
 *   - never confirmed → optimistic in-flight (the eager send hasn't reached a
 *     snapshot yet) → KEEP the chip.
 *   - was confirmed (seen in a prior snapshot) but now absent + not promoted →
 *     it left the queue without running → dropped (user-cancel removes it
 *     client-side first; the only server-side path is a respawn that lost the
 *     queue). v1: drop. See message-queue-ownership "reconnect" section.
 */
export interface PendingSend {
  clientMsgId: string;
  content: string;
  images?: string[];
  files?: AgentFile[];
  /** Has this id appeared in a server snapshot at least once? */
  confirmed: boolean;
}

/**
 * A reconcile mismatch the caller MUST log (no silent drops). Each is a case
 * where the server's authoritative snapshot and the renderer's optimistic state
 * disagree — benign on reconnect / multi-tab, but a bug-signal otherwise.
 */
export type QueueAnomalyKind =
  /** Snapshot says 'running' but there's no local optimistic content → no
   *  timeline bubble can be rendered for it (e.g. reconnect / another tab). */
  | 'promote-without-content'
  /** A confirmed chip (seen in a prior snapshot) vanished WITHOUT running → its
   *  chip is dropped. The user didn't cancel it (that removes it client-side
   *  first), so this means the server lost it — typically an agent-server
   *  respawn. Potential message loss; loudest anomaly. */
  | 'dropped-confirmed-vanished';

// NOTE: deliberately NO 'queued id with no local content' anomaly. An in-flight
// snapshot emitted just before the server processes a cancel/ESC still lists the
// id the client already removed — a benign race that would false-fire on every
// cancel. A genuine "server running something we don't know" is still caught by
// 'promote-without-content' when that item actually runs.

export interface QueueAnomaly {
  kind: QueueAnomalyKind;
  clientMsgId: string;
}

export interface QueueReconcileResult {
  /** Next chip list (waiting sends), in order. */
  pending: PendingSend[];
  /** Items whose turn just started → caller adds each as a timeline user bubble. */
  promote: PendingSend[];
  /** Next promoted-id set (dedup guard). */
  promoted: Set<string>;
  /** Snapshot↔optimistic mismatches the caller MUST surface (never silent). */
  anomalies: QueueAnomaly[];
}

export function reconcileQueueSnapshot(
  pending: PendingSend[],
  promoted: Set<string>,
  snapshot: AgentQueueItem[],
): QueueReconcileResult {
  const byId = new Map(pending.map((p) => [p.clientMsgId, p]));
  const snapState = new Map(snapshot.map((s) => [s.clientMsgId, s.state]));
  const nextPromoted = new Set(promoted);
  const promote: PendingSend[] = [];
  const anomalies: QueueAnomaly[] = [];

  // Promotions: 'running' ids not yet promoted. Iterate the snapshot so promote
  // order is the server's FIFO order. An id running with no local content
  // (another tab, or post-reconnect with no optimistic entry) is still marked
  // promoted to avoid re-checking, but produces no bubble — flagged as an
  // anomaly so it's never a silent skip.
  for (const item of snapshot) {
    if (item.state !== 'running' || nextPromoted.has(item.clientMsgId)) continue;
    nextPromoted.add(item.clientMsgId);
    const p = byId.get(item.clientMsgId);
    if (p) promote.push(p);
    else anomalies.push({ kind: 'promote-without-content', clientMsgId: item.clientMsgId });
  }

  // Forget promoted ids no longer in the snapshot: their turn finished and
  // clientMsgId is unique (never reappears), so dropping them keeps the set
  // bounded to the current in-flight window instead of growing per turn.
  for (const id of nextPromoted) {
    if (!snapState.has(id)) nextPromoted.delete(id);
  }

  const next: PendingSend[] = [];
  for (const p of pending) {
    if (nextPromoted.has(p.clientMsgId)) continue; // now a bubble, not a chip
    const state = snapState.get(p.clientMsgId);
    if (state === 'queued') {
      next.push(p.confirmed ? p : { ...p, confirmed: true });
    } else if (state === undefined) {
      // Absent from snapshot: keep if still optimistic (not yet acked), but if it
      // had been confirmed and vanished WITHOUT running, it was dropped by the
      // server (user-cancel removes it client-side first, so this is respawn /
      // desync loss) → flag, don't drop silently.
      if (!p.confirmed) next.push(p);
      else anomalies.push({ kind: 'dropped-confirmed-vanished', clientMsgId: p.clientMsgId });
    }
    // state === 'running' handled by the promote loop above.
  }

  return { pending: next, promote, promoted: nextPromoted, anomalies };
}
