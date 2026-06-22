import { describe, it, expect } from 'vitest';
import type { AgentQueueItem } from '../shared/types';
import { reconcileQueueSnapshot, type PendingSend } from './queue-reconcile';

const mk = (id: string, confirmed = false): PendingSend => ({ clientMsgId: id, content: `c-${id}`, confirmed });
const snap = (...items: Array<[string, 'queued' | 'running']>): AgentQueueItem[] =>
  items.map(([clientMsgId, state]) => ({ clientMsgId, state }));

describe('reconcileQueueSnapshot', () => {
  it('promotes an optimistic item when its turn starts running (idle send)', () => {
    const r = reconcileQueueSnapshot([mk('a')], new Set(), snap(['a', 'running']));
    expect(r.promote.map((p) => p.clientMsgId)).toEqual(['a']);
    expect(r.pending).toEqual([]); // chip became a bubble
    expect([...r.promoted]).toEqual(['a']);
    expect(r.anomalies).toEqual([]); // normal flow → no anomaly
  });

  it('confirms a queued item as a chip without promoting', () => {
    const r = reconcileQueueSnapshot([mk('a', true), mk('b')], new Set(['a']), snap(['a', 'running'], ['b', 'queued']));
    // a already promoted → no re-promote; b stays a (now confirmed) chip.
    expect(r.promote).toEqual([]);
    expect(r.pending.map((p) => p.clientMsgId)).toEqual(['b']);
    expect(r.pending[0].confirmed).toBe(true);
  });

  it('does not re-promote an already-promoted running item', () => {
    const r = reconcileQueueSnapshot([], new Set(['a']), snap(['a', 'running']));
    expect(r.promote).toEqual([]);
    expect([...r.promoted]).toEqual(['a']);
  });

  it('keeps an optimistic item absent from the snapshot (in-flight, not yet acked)', () => {
    const r = reconcileQueueSnapshot([mk('a')], new Set(), []);
    expect(r.pending.map((p) => p.clientMsgId)).toEqual(['a']);
    expect(r.promote).toEqual([]);
  });

  it('drops a previously-confirmed item that vanished without running, and FLAGS it (not silent)', () => {
    const r = reconcileQueueSnapshot([mk('a', true)], new Set(), []);
    expect(r.pending).toEqual([]);
    expect(r.promote).toEqual([]);
    expect(r.anomalies).toEqual([{ kind: 'dropped-confirmed-vanished', clientMsgId: 'a' }]);
  });

  it('does NOT flag a never-confirmed optimistic item absent from the snapshot (still in-flight)', () => {
    const r = reconcileQueueSnapshot([mk('a', false)], new Set(), []);
    expect(r.pending.map((p) => p.clientMsgId)).toEqual(['a']);
    expect(r.anomalies).toEqual([]);
  });

  it('promotes in snapshot (FIFO) order when several start at once', () => {
    const r = reconcileQueueSnapshot([mk('b'), mk('a')], new Set(), snap(['a', 'running'], ['b', 'running']));
    expect(r.promote.map((p) => p.clientMsgId)).toEqual(['a', 'b']); // snapshot order, not pending order
    expect(r.pending).toEqual([]);
  });

  it('marks a running id promoted even with no local content (other tab / reconnect) and FLAGS it', () => {
    const r = reconcileQueueSnapshot([], new Set(), snap(['x', 'running']));
    expect(r.promote).toEqual([]); // no bubble — no content
    expect([...r.promoted]).toEqual(['x']); // but guarded against future re-promote
    expect(r.anomalies).toEqual([{ kind: 'promote-without-content', clientMsgId: 'x' }]);
  });

  it('prunes promoted ids that left the snapshot (bounded set)', () => {
    // a was promoted earlier, now gone from the snapshot; b is newly running.
    const r = reconcileQueueSnapshot([], new Set(['a']), snap(['b', 'running']));
    expect([...r.promoted].sort()).toEqual(['b']); // a forgotten, b added
  });

  it('full lifecycle: queue two, drain first, then second', () => {
    // submit a (idle) then b (busy): start with both optimistic.
    let pending = [mk('a'), mk('b')];
    let promoted = new Set<string>();

    // snapshot 1: a running, b queued
    let r = reconcileQueueSnapshot(pending, promoted, snap(['a', 'running'], ['b', 'queued']));
    expect(r.promote.map((p) => p.clientMsgId)).toEqual(['a']);
    expect(r.pending.map((p) => p.clientMsgId)).toEqual(['b']);
    pending = r.pending; promoted = r.promoted;

    // snapshot 2: a done (gone), b running
    r = reconcileQueueSnapshot(pending, promoted, snap(['b', 'running']));
    expect(r.promote.map((p) => p.clientMsgId)).toEqual(['b']);
    expect(r.pending).toEqual([]);
    pending = r.pending; promoted = r.promoted;

    // snapshot 3: empty (b done)
    r = reconcileQueueSnapshot(pending, promoted, []);
    expect(r.promote).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});
