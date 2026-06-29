import { describe, it, expect, vi } from 'vitest';
import { createTurnDispatcher, type PermissionHandler } from './turn-dispatcher';
import type { AgentEvent } from './types';

// Minimal stand-in for `parseRemoteMessage` in remote.ts — we only need it
// to convert wire shapes the dispatcher routes (status / message / etc.)
// into AgentEvent for the per-turn queue.
function parse(msg: any): AgentEvent | null {
  if (msg?.type === 'status') {
    return { type: 'status', payload: { state: msg.state } as any };
  }
  if (msg?.type === 'message') {
    return { type: 'message', payload: { type: msg.msgType, content: msg.content ?? '' } as any };
  }
  if (msg?.type === 'stream') {
    return { type: 'stream', payload: { type: msg.streamType, content: msg.content ?? '' } as any };
  }
  if (msg?.type === 'error') {
    return { type: 'error', error: msg.error ?? '' };
  }
  return null;
}

const noopPerm: PermissionHandler = () => {};

describe('createTurnDispatcher', () => {
  it('routes events to the correct turn by turnId envelope', async () => {
    const d = createTurnDispatcher(parse);
    const gen1 = d.registerTurn('t-aaaa', noopPerm);
    const gen2 = d.registerTurn('t-bbbb', noopPerm);

    // Cross-turn events arriving interleaved on the same dispatcher
    d.feed({ type: 'message', msgType: 'text', content: 'for-a', turnId: 't-aaaa' });
    d.feed({ type: 'message', msgType: 'text', content: 'for-b', turnId: 't-bbbb' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-aaaa' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-bbbb' });

    const aEvents: AgentEvent[] = [];
    for await (const e of gen1) aEvents.push(e);
    const bEvents: AgentEvent[] = [];
    for await (const e of gen2) bEvents.push(e);

    expect(aEvents.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['for-a', 'idle']);
    expect(bEvents.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['for-b', 'idle']);
  });

  it('drops events for unknown turnIds (stale-turn leftover, e.g. claude.ts finally idle)', async () => {
    const d = createTurnDispatcher(parse);
    const gen = d.registerTurn('t-current', noopPerm);

    // Leftover from a previous turn that's already been unregistered
    d.feed({ type: 'status', state: 'idle', turnId: 't-old' });
    d.feed({ type: 'message', msgType: 'text', content: 'stale', turnId: 't-old' });

    // Real events for the current turn
    d.feed({ type: 'message', msgType: 'text', content: 'hello', turnId: 't-current' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-current' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    // Only current turn's events; stale ones silently dropped
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['hello', 'idle']);
  });

  it('drops events with no turnId (lifecycle outside any turn)', async () => {
    const d = createTurnDispatcher(parse);
    const gen = d.registerTurn('t-x', noopPerm);

    // turnId-less per-turn event (shouldn't happen with new protocol, but
    // we defensively drop rather than misroute to current turn)
    d.feed({ type: 'message', msgType: 'text', content: 'ghost' });

    d.feed({ type: 'message', msgType: 'text', content: 'ok', turnId: 't-x' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['ok', 'idle']);
  });

  it('routes permission_request to per-turn handler, not the event queue', async () => {
    const d = createTurnDispatcher(parse);
    const permA = vi.fn();
    const permB = vi.fn();
    const genA = d.registerTurn('t-aaaa', permA);
    const genB = d.registerTurn('t-bbbb', permB);

    d.feed({ type: 'permission_request', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'ls' }, turnId: 't-aaaa' });
    d.feed({ type: 'permission_request', toolUseId: 'tool-2', toolName: 'Read', input: { file_path: '/etc' }, turnId: 't-bbbb' });

    // Each turn's handler only saw its own permission request
    expect(permA).toHaveBeenCalledExactlyOnceWith('tool-1', 'Bash', { command: 'ls' });
    expect(permB).toHaveBeenCalledExactlyOnceWith('tool-2', 'Read', { file_path: '/etc' });

    // Permission requests don't appear in the event queue — close turns and
    // verify queue is empty (just the idle event we send below)
    d.feed({ type: 'status', state: 'idle', turnId: 't-aaaa' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-bbbb' });

    const aEvents: AgentEvent[] = [];
    for await (const e of genA) aEvents.push(e);
    const bEvents: AgentEvent[] = [];
    for await (const e of genB) bEvents.push(e);
    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    expect(((aEvents[0] as any).payload).state).toBe('idle');
  });

  it('drains tail events that arrive between idle and generator exit', async () => {
    const d = createTurnDispatcher(parse);
    const gen = d.registerTurn('t-x', noopPerm);

    // Burst arrives all at once; queue contains tail events after idle
    d.feed({ type: 'message', msgType: 'text', content: 'a', turnId: 't-x' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });
    d.feed({ type: 'message', msgType: 'text', content: 'tail', turnId: 't-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    // 'a' (pre-idle), 'idle', 'tail' (post-idle but pre-drain) all yielded
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['a', 'idle', 'tail']);
  });

  it('awaitReady resolves true when {type:ready} arrives', async () => {
    const d = createTurnDispatcher(parse);
    const pending = d.awaitReady(5000);
    d.feed({ type: 'ready' });
    expect(await pending).toBe(true);
  });

  it('awaitReady resolves false on timeout when no ready arrives', async () => {
    const d = createTurnDispatcher(parse);
    const result = await d.awaitReady(50);
    expect(result).toBe(false);
  });

  it('routes requestId-keyed responses (capabilities / credential / slash) independent of any turn', () => {
    const d = createTurnDispatcher(parse);
    const captured: any[] = [];
    d.onResponse('cap-1', 'capabilities', (p) => captured.push(p));
    d.feed({ type: 'capabilities', requestId: 'cap-1', models: [], permissionModes: [], effortLevels: [], slashCommands: [] });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('capabilities');

    // Handlers are one-shot — same requestId firing again is dropped
    d.feed({ type: 'capabilities', requestId: 'cap-1', error: 'late' });
    expect(captured).toHaveLength(1);
  });

  // ── Background tasks: turnId-less routing (the "unknown turn dropping" fix) ──
  it('routes task_event (turnId-less) to the onTaskEvent sink, not the turn queue', async () => {
    const taskEvents: any[] = [];
    const d = createTurnDispatcher(parse, (ev) => taskEvents.push(ev));
    const gen = d.registerTurn('t-x', noopPerm);

    d.feed({
      type: 'task_event',
      kind: 'started',
      task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', done: false },
    });
    d.feed({ type: 'message', msgType: 'text', content: 'hi', turnId: 't-x' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    // task_event went to the sink, NOT into the turn's event stream
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['hi', 'idle']);
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]).toEqual({
      kind: 'started',
      task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', done: false },
      tasks: undefined,
    });
  });

  it('delivers task_event AFTER the turn went idle (regression: backgrounded task no longer dropped as unknown turn)', async () => {
    const taskEvents: any[] = [];
    const d = createTurnDispatcher(parse, (ev) => taskEvents.push(ev));
    const gen = d.registerTurn('t-x', noopPerm);

    // Foreground turn completes...
    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events).toHaveLength(1);

    // ...then the backgrounded task keeps emitting. Pre-fix these carried the
    // now-dead turnId and were logged as "event for unknown turn … dropping".
    // task_event is turnId-less, so it reaches the sink regardless of turn state.
    d.feed({
      type: 'task_event',
      kind: 'progress',
      task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', summary: 'still running', done: false },
    });
    d.feed({
      type: 'task_event',
      kind: 'done',
      task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'completed', done: true },
    });

    expect(taskEvents.map((e) => e.kind)).toEqual(['progress', 'done']);
  });

  it('passes a snapshot task_event (tasks[] reconcile) through to the sink', () => {
    const taskEvents: any[] = [];
    const d = createTurnDispatcher(parse, (ev) => taskEvents.push(ev));
    d.feed({
      type: 'task_event',
      kind: 'snapshot',
      tasks: [
        { id: 'a', type: 'shell', label: 'x', status: 'running', done: false },
        { id: 'b', type: 'subagent', label: 'y', status: 'completed', done: true },
      ],
    });
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0].kind).toBe('snapshot');
    expect(taskEvents[0].tasks).toHaveLength(2);
  });

  it('routes queue snapshot (turnId-less) to the onQueue sink, not the turn queue', async () => {
    const queueSnaps: any[] = [];
    const d = createTurnDispatcher(parse, undefined, undefined, (items) => queueSnaps.push(items));
    const gen = d.registerTurn('t-x', noopPerm);

    d.feed({ type: 'queue', items: [{ clientMsgId: 'a', state: 'running' }, { clientMsgId: 'b', state: 'queued' }] });
    d.feed({ type: 'message', msgType: 'text', content: 'hi', turnId: 't-x' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    // queue snapshot went to the sink, NOT into the turn's event stream.
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['hi', 'idle']);
    expect(queueSnaps).toHaveLength(1);
    expect(queueSnaps[0]).toEqual([{ clientMsgId: 'a', state: 'running' }, { clientMsgId: 'b', state: 'queued' }]);
  });

  it('queue snapshot without an onQueue sink is a harmless no-op; malformed items do NOT call the sink', () => {
    const d = createTurnDispatcher(parse);
    expect(() => d.feed({ type: 'queue', items: [{ clientMsgId: 'a', state: 'queued' }] })).not.toThrow();
    // Malformed (non-array) items must NOT reach the sink — an empty snapshot
    // would wrongly drop the renderer's queued chips. The dispatcher logs + skips.
    const snaps: any[] = [];
    const d2 = createTurnDispatcher(parse, undefined, undefined, (items) => snaps.push(items));
    d2.feed({ type: 'queue' });
    expect(snaps).toEqual([]); // sink not called
    d2.feed({ type: 'queue', items: [{ clientMsgId: 'a', state: 'queued' }] });
    expect(snaps).toEqual([[{ clientMsgId: 'a', state: 'queued' }]]); // valid → delivered
  });

  it('task_event without an onTaskEvent sink is a harmless no-op (does not throw / misroute)', async () => {
    const d = createTurnDispatcher(parse);
    const gen = d.registerTurn('t-x', noopPerm);
    expect(() => d.feed({ type: 'task_event', kind: 'started', task: { id: 'task-1', type: 'shell', label: 's', status: 'running', done: false } })).not.toThrow();
    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events).toHaveLength(1);
  });

  it('removes turn state when generator exits — subsequent events for same turnId are dropped', async () => {
    const d = createTurnDispatcher(parse);
    const gen = d.registerTurn('t-x', noopPerm);

    d.feed({ type: 'status', state: 'idle', turnId: 't-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events).toHaveLength(1);

    // After generator exits, the turn is unregistered. New events for that
    // turnId should be silently dropped (not crash, not misroute).
    expect(() => d.feed({ type: 'message', msgType: 'text', content: 'late', turnId: 't-x' })).not.toThrow();
  });

  // ── Server-initiated turn (auto-resume prose) — background-tasks#2 ──

  it('turn_started registers the turn and hands its generator to onServerTurn; subsequent prose routes there (not dropped as unknown turn)', async () => {
    const handed: Array<{ turnId: string; events: AsyncGenerator<AgentEvent> }> = [];
    const d = createTurnDispatcher(parse, undefined, (turnId, events) => {
      handed.push({ turnId, events });
    });

    // Provider opens a server turn the main side never sent a `send` for.
    d.feed({ type: 'turn_started', turnId: 't-srv' });
    // Its prose + idle arrive on later lines — must route to the registered turn.
    d.feed({ type: 'message', msgType: 'reply', content: 'sleep done', turnId: 't-srv' });
    d.feed({ type: 'status', state: 'idle', turnId: 't-srv' });

    expect(handed).toHaveLength(1);
    expect(handed[0].turnId).toBe('t-srv');

    const events: AgentEvent[] = [];
    for await (const e of handed[0].events) events.push(e);
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state))
      .toEqual(['sleep done', 'idle']);
  });

  it('turn_started without an onServerTurn sink is a harmless no-op', () => {
    const d = createTurnDispatcher(parse);
    expect(() => d.feed({ type: 'turn_started', turnId: 't-srv' })).not.toThrow();
  });

  it('ignores a duplicate turn_started for an already-registered turnId', () => {
    const handed: string[] = [];
    const d = createTurnDispatcher(parse, undefined, (turnId) => { handed.push(turnId); });
    d.feed({ type: 'turn_started', turnId: 't-srv' });
    d.feed({ type: 'turn_started', turnId: 't-srv' });
    expect(handed).toEqual(['t-srv']);
  });

  it('routes skills_reloaded to the session sink (turnId-less, before the turn check)', () => {
    const seen: Array<{ ok: boolean; error?: string }> = [];
    const d = createTurnDispatcher(parse, undefined, undefined, undefined, (ok, error) => seen.push({ ok, error }));
    d.feed({ type: 'skills_reloaded', ok: true });
    d.feed({ type: 'skills_reloaded', ok: false, error: 'rpc down' });
    expect(seen).toEqual([{ ok: true, error: undefined }, { ok: false, error: 'rpc down' }]);
  });

  it('skills_reloaded without a sink is a harmless no-op (not dropped as unknown turn)', () => {
    const d = createTurnDispatcher(parse);
    expect(() => d.feed({ type: 'skills_reloaded', ok: true })).not.toThrow();
  });
});
