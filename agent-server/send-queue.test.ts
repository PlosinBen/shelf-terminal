import { describe, it, expect } from 'vitest';
import type { AgentQueueItem } from '@shared/types';
import { createSendQueue, type QueuedSend } from './send-queue';

interface Msg extends QueuedSend { id: string }

function setup() {
  const snapshots: AgentQueueItem[][] = [];
  const terminated: string[] = [];
  const errors: Array<{ msg: Msg; err: unknown }> = [];
  const anomalies: Array<{ reason: string; clientMsgId: string }> = [];
  // Controllable handles: each handle() parks until the test resolves/rejects it.
  const handles: Array<{ msg: Msg; resolve: () => void; reject: (e: unknown) => void }> = [];
  const q = createSendQueue<Msg>({
    handle: (msg) => new Promise<void>((resolve, reject) => handles.push({ msg, resolve, reject })),
    emitSnapshot: (items) => snapshots.push(items),
    terminateTurn: (t) => terminated.push(t),
    onHandleError: (msg, err) => errors.push({ msg, err }),
    onAnomaly: (reason, clientMsgId) => anomalies.push({ reason, clientMsgId }),
  });
  return { q, snapshots, terminated, errors, anomalies, handles };
}

// Flush the microtask/macrotask queue so pump's Promise.then/finally chain runs.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const running = (id: string): AgentQueueItem => ({ clientMsgId: id, state: 'running' });
const queued = (id: string): AgentQueueItem => ({ clientMsgId: id, state: 'queued' });

describe('createSendQueue', () => {
  it('idle enqueue runs immediately with no queued flash', async () => {
    const { q, snapshots, handles } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    // First (and only) snapshot is [running] — no intermediate 'queued'.
    expect(snapshots).toEqual([[running('a')]]);
    await flush();
    expect(handles.map((h) => h.msg.id)).toEqual(['a']);
    handles[0].resolve();
    await flush();
    // Drain-to-empty emits [].
    expect(snapshots.at(-1)).toEqual([]);
  });

  it('serializes: second send waits as queued until the first completes', async () => {
    const { q, snapshots, handles } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    q.enqueue({ id: 'b', clientMsgId: 'b', turnId: 't2' });
    expect(snapshots).toEqual([
      [running('a')],
      [running('a'), queued('b')],
    ]);
    await flush();
    expect(handles.map((h) => h.msg.id)).toEqual(['a']); // b not started yet
    handles[0].resolve();
    await flush();
    expect(handles.map((h) => h.msg.id)).toEqual(['a', 'b']);
    expect(snapshots.at(-1)).toEqual([running('b')]);
    handles[1].resolve();
    await flush();
    expect(snapshots.at(-1)).toEqual([]);
  });

  it('cancel removes a queued send + terminates its turn; never runs it', async () => {
    const { q, snapshots, terminated, handles } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    q.enqueue({ id: 'b', clientMsgId: 'b', turnId: 't2' });
    q.enqueue({ id: 'c', clientMsgId: 'c', turnId: 't3' });
    q.cancel('b');
    expect(terminated).toEqual(['t2']);
    expect(snapshots.at(-1)).toEqual([running('a'), queued('c')]);
    await flush();
    handles[0].resolve();
    await flush();
    // c runs next; b was dropped, so only a + c ever handled.
    expect(handles.map((h) => h.msg.id)).toEqual(['a', 'c']);
  });

  it('cancel of the running send is a no-op but is FLAGGED (cancel-running), not silent', async () => {
    const { q, snapshots, terminated, anomalies } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    const before = snapshots.length;
    q.cancel('a'); // already running → not in queue
    expect(terminated).toEqual([]);
    expect(snapshots.length).toBe(before); // no new snapshot
    expect(anomalies).toEqual([{ reason: 'cancel-running', clientMsgId: 'a' }]);
  });

  it('cancel of an unknown id is FLAGGED (cancel-unknown), not silent', () => {
    const { q, anomalies } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    q.cancel('nope');
    expect(anomalies).toEqual([{ reason: 'cancel-unknown', clientMsgId: 'nope' }]);
  });

  it('a clean cancel of a queued send does NOT flag an anomaly', () => {
    const { q, anomalies } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    q.enqueue({ id: 'b', clientMsgId: 'b', turnId: 't2' });
    q.cancel('b');
    expect(anomalies).toEqual([]);
  });

  it('clear drops every waiting send (keeps the running one)', async () => {
    const { q, snapshots, terminated } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    q.enqueue({ id: 'b', clientMsgId: 'b', turnId: 't2' });
    q.enqueue({ id: 'c', clientMsgId: 'c', turnId: 't3' });
    q.clear();
    expect(terminated).toEqual(['t2', 't3']);
    expect(snapshots.at(-1)).toEqual([running('a')]);
  });

  it('omits sends without a clientMsgId from the snapshot but still serializes them', async () => {
    const { q, snapshots, handles } = setup();
    q.enqueue({ id: 'internal', turnId: 't1' }); // no clientMsgId
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't2' });
    // internal running (no clientMsgId → not shown); a queued.
    expect(snapshots).toEqual([
      [],
      [queued('a')],
    ]);
    await flush();
    expect(handles.map((h) => h.msg.id)).toEqual(['internal']);
    handles[0].resolve();
    await flush();
    expect(snapshots.at(-1)).toEqual([running('a')]);
  });

  it('a thrown handle ends the turn and continues to the next', async () => {
    const { q, snapshots, errors, handles } = setup();
    q.enqueue({ id: 'a', clientMsgId: 'a', turnId: 't1' });
    q.enqueue({ id: 'b', clientMsgId: 'b', turnId: 't2' });
    await flush();
    handles[0].reject(new Error('boom'));
    await flush();
    expect(errors.map((e) => e.msg.id)).toEqual(['a']);
    // pump continued → b now running.
    expect(handles.map((h) => h.msg.id)).toEqual(['a', 'b']);
    expect(snapshots.at(-1)).toEqual([running('b')]);
  });
});
