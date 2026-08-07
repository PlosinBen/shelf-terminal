import { describe, it, expect, vi } from 'vitest';
import { createExecutionDispatcher, type PermissionHandler } from './execution-dispatcher';
import type { AgentEvent } from './types';

// Minimal stand-in for `parseRemoteMessage` in remote.ts — we only need it
// to convert wire shapes the dispatcher routes (status / message / etc.)
// into AgentEvent for the per-execution queue.
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

describe('createExecutionDispatcher', () => {
  it('routes events to the correct execution by executionId envelope', async () => {
    const d = createExecutionDispatcher(parse);
    const gen1 = d.registerExecution('e-aaaa', noopPerm);
    const gen2 = d.registerExecution('e-bbbb', noopPerm);

    // Cross-execution events arriving interleaved on the same dispatcher
    d.feed({ type: 'message', msgType: 'text', content: 'for-a', executionId: 'e-aaaa' });
    d.feed({ type: 'message', msgType: 'text', content: 'for-b', executionId: 'e-bbbb' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-aaaa' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-bbbb' });

    const aEvents: AgentEvent[] = [];
    for await (const e of gen1) aEvents.push(e);
    const bEvents: AgentEvent[] = [];
    for await (const e of gen2) bEvents.push(e);

    expect(aEvents.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['for-a', 'idle']);
    expect(bEvents.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['for-b', 'idle']);
  });

  it('drops events for unknown executionIds (stale-execution leftover, e.g. claude.ts finally idle)', async () => {
    const d = createExecutionDispatcher(parse);
    const gen = d.registerExecution('e-current', noopPerm);

    // Leftover from a previous execution that's already been unregistered
    d.feed({ type: 'status', state: 'idle', executionId: 'e-old' });
    d.feed({ type: 'message', msgType: 'text', content: 'stale', executionId: 'e-old' });

    // Real events for the current execution
    d.feed({ type: 'message', msgType: 'text', content: 'hello', executionId: 'e-current' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-current' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    // Only current execution's events; stale ones silently dropped
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['hello', 'idle']);
  });

  it('drops events with no executionId (lifecycle outside any execution)', async () => {
    const d = createExecutionDispatcher(parse);
    const gen = d.registerExecution('e-x', noopPerm);

    // executionId-less per-execution event (shouldn't happen with new protocol, but
    // we defensively drop rather than misroute to current execution)
    d.feed({ type: 'message', msgType: 'text', content: 'ghost' });

    d.feed({ type: 'message', msgType: 'text', content: 'ok', executionId: 'e-x' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['ok', 'idle']);
  });

  it('routes permission_request to per-execution handler, not the event queue', async () => {
    const d = createExecutionDispatcher(parse);
    const permA = vi.fn();
    const permB = vi.fn();
    const genA = d.registerExecution('e-aaaa', permA);
    const genB = d.registerExecution('e-bbbb', permB);

    d.feed({ type: 'permission_request', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'ls' }, executionId: 'e-aaaa' });
    d.feed({ type: 'permission_request', toolUseId: 'tool-2', toolName: 'Read', input: { file_path: '/etc' }, executionId: 'e-bbbb' });

    // Each execution's handler only saw its own permission request
    expect(permA).toHaveBeenCalledExactlyOnceWith('tool-1', 'Bash', { command: 'ls' });
    expect(permB).toHaveBeenCalledExactlyOnceWith('tool-2', 'Read', { file_path: '/etc' });

    // Permission requests don't appear in the event queue — close executions and
    // verify queue is empty (just the idle event we send below)
    d.feed({ type: 'status', state: 'idle', executionId: 'e-aaaa' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-bbbb' });

    const aEvents: AgentEvent[] = [];
    for await (const e of genA) aEvents.push(e);
    const bEvents: AgentEvent[] = [];
    for await (const e of genB) bEvents.push(e);
    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    expect(((aEvents[0] as any).payload).state).toBe('idle');
  });

  it('drains tail events that arrive between idle and generator exit', async () => {
    const d = createExecutionDispatcher(parse);
    const gen = d.registerExecution('e-x', noopPerm);

    // Burst arrives all at once; queue contains tail events after idle
    d.feed({ type: 'message', msgType: 'text', content: 'a', executionId: 'e-x' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });
    d.feed({ type: 'message', msgType: 'text', content: 'tail', executionId: 'e-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    // 'a' (pre-idle), 'idle', 'tail' (post-idle but pre-drain) all yielded
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['a', 'idle', 'tail']);
  });

  it('awaitReady resolves true when {type:ready} arrives', async () => {
    const d = createExecutionDispatcher(parse);
    const pending = d.awaitReady(5000);
    d.feed({ type: 'ready' });
    expect(await pending).toBe(true);
  });

  it('awaitReady resolves false on timeout when no ready arrives', async () => {
    const d = createExecutionDispatcher(parse);
    const result = await d.awaitReady(50);
    expect(result).toBe(false);
  });

  it('routes requestId-keyed responses (capabilities / credential / slash) independent of any execution', () => {
    const d = createExecutionDispatcher(parse);
    const captured: any[] = [];
    d.onResponse('cap-1', 'capabilities', (p) => captured.push(p));
    d.feed({ type: 'capabilities', requestId: 'cap-1', models: [], permissionModes: [], effortLevels: [], slashCommands: [] });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('capabilities');

    // Handlers are one-shot — same requestId firing again is dropped
    d.feed({ type: 'capabilities', requestId: 'cap-1', error: 'late' });
    expect(captured).toHaveLength(1);
  });

  // ── Background tasks: executionId-less routing (the "unknown execution dropping" fix) ──
  it('routes task_event (executionId-less) to the onTaskEvent sink, not the execution queue', async () => {
    const taskEvents: any[] = [];
    const d = createExecutionDispatcher(parse, (ev) => taskEvents.push(ev));
    const gen = d.registerExecution('e-x', noopPerm);

    d.feed({
      type: 'task_event',
      kind: 'started',
      task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', done: false },
    });
    d.feed({ type: 'message', msgType: 'text', content: 'hi', executionId: 'e-x' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    // task_event went to the sink, NOT into the execution's event stream
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['hi', 'idle']);
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]).toEqual({
      kind: 'started',
      task: { id: 'task-1', type: 'shell', label: 'sleep 30', status: 'running', done: false },
      tasks: undefined,
    });
  });

  it('delivers task_event AFTER the execution went idle (regression: backgrounded task no longer dropped as unknown execution)', async () => {
    const taskEvents: any[] = [];
    const d = createExecutionDispatcher(parse, (ev) => taskEvents.push(ev));
    const gen = d.registerExecution('e-x', noopPerm);

    // Foreground execution completes...
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events).toHaveLength(1);

    // ...then the backgrounded task keeps emitting. Pre-fix these carried the
    // now-dead executionId and were logged as "event for unknown execution … dropping".
    // task_event is executionId-less, so it reaches the sink regardless of execution state.
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
    const d = createExecutionDispatcher(parse, (ev) => taskEvents.push(ev));
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

  it('routes queue snapshot (executionId-less) to the onQueue sink, not the execution queue', async () => {
    const queueSnaps: any[] = [];
    const d = createExecutionDispatcher(parse, undefined, undefined, (items) => queueSnaps.push(items));
    const gen = d.registerExecution('e-x', noopPerm);

    d.feed({ type: 'queue', items: [{ clientMsgId: 'a', state: 'running' }, { clientMsgId: 'b', state: 'queued' }] });
    d.feed({ type: 'message', msgType: 'text', content: 'hi', executionId: 'e-x' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });

    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);

    // queue snapshot went to the sink, NOT into the execution's event stream.
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state)).toEqual(['hi', 'idle']);
    expect(queueSnaps).toHaveLength(1);
    expect(queueSnaps[0]).toEqual([{ clientMsgId: 'a', state: 'running' }, { clientMsgId: 'b', state: 'queued' }]);
  });

  it('queue snapshot without an onQueue sink is a harmless no-op; malformed items do NOT call the sink', () => {
    const d = createExecutionDispatcher(parse);
    expect(() => d.feed({ type: 'queue', items: [{ clientMsgId: 'a', state: 'queued' }] })).not.toThrow();
    // Malformed (non-array) items must NOT reach the sink — an empty snapshot
    // would wrongly drop the renderer's queued chips. The dispatcher logs + skips.
    const snaps: any[] = [];
    const d2 = createExecutionDispatcher(parse, undefined, undefined, (items) => snaps.push(items));
    d2.feed({ type: 'queue' });
    expect(snaps).toEqual([]); // sink not called
    d2.feed({ type: 'queue', items: [{ clientMsgId: 'a', state: 'queued' }] });
    expect(snaps).toEqual([[{ clientMsgId: 'a', state: 'queued' }]]); // valid → delivered
  });

  it('task_event without an onTaskEvent sink is a harmless no-op (does not throw / misroute)', async () => {
    const d = createExecutionDispatcher(parse);
    const gen = d.registerExecution('e-x', noopPerm);
    expect(() => d.feed({ type: 'task_event', kind: 'started', task: { id: 'task-1', type: 'shell', label: 's', status: 'running', done: false } })).not.toThrow();
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events).toHaveLength(1);
  });

  it('removes execution state when generator exits — subsequent events for same executionId are dropped', async () => {
    const d = createExecutionDispatcher(parse);
    const gen = d.registerExecution('e-x', noopPerm);

    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events).toHaveLength(1);

    // After generator exits, the execution is unregistered. New events for that
    // executionId should be silently dropped (not crash, not misroute).
    expect(() => d.feed({ type: 'message', msgType: 'text', content: 'late', executionId: 'e-x' })).not.toThrow();
  });

  // ── Server-initiated execution (auto-resume prose) — background-tasks#2 ──

  it('execution_started registers the execution and hands its generator to onServerExecution; subsequent prose routes there (not dropped as unknown execution)', async () => {
    const handed: Array<{ executionId: string; events: AsyncGenerator<AgentEvent> }> = [];
    const d = createExecutionDispatcher(parse, undefined, (executionId, events) => {
      handed.push({ executionId, events });
    });

    // Provider opens a server execution the main side never sent a `send` for.
    d.feed({ type: 'execution_started', executionId: 'e-srv' });
    // Its prose + idle arrive on later lines — must route to the registered execution.
    d.feed({ type: 'message', msgType: 'reply', content: 'sleep done', executionId: 'e-srv' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-srv' });

    expect(handed).toHaveLength(1);
    expect(handed[0].executionId).toBe('e-srv');

    const events: AgentEvent[] = [];
    for await (const e of handed[0].events) events.push(e);
    expect(events.map((e) => ((e as any).payload)?.content ?? ((e as any).payload)?.state))
      .toEqual(['sleep done', 'idle']);
  });

  it('execution_started without an onServerExecution sink is a harmless no-op', () => {
    const d = createExecutionDispatcher(parse);
    expect(() => d.feed({ type: 'execution_started', executionId: 'e-srv' })).not.toThrow();
  });

  it('ignores a duplicate execution_started for an already-registered executionId', () => {
    const handed: string[] = [];
    const d = createExecutionDispatcher(parse, undefined, (executionId) => { handed.push(executionId); });
    d.feed({ type: 'execution_started', executionId: 'e-srv' });
    d.feed({ type: 'execution_started', executionId: 'e-srv' });
    expect(handed).toEqual(['e-srv']);
  });

  it('routes skills_reloaded to the session sink (executionId-less, before the execution check)', () => {
    const seen: Array<{ ok: boolean; error?: string }> = [];
    const d = createExecutionDispatcher(parse, undefined, undefined, undefined, (ok, error) => seen.push({ ok, error }));
    d.feed({ type: 'skills_reloaded', ok: true });
    d.feed({ type: 'skills_reloaded', ok: false, error: 'rpc down' });
    expect(seen).toEqual([{ ok: true, error: undefined }, { ok: false, error: 'rpc down' }]);
  });

  it('skills_reloaded without a sink is a harmless no-op (not dropped as unknown execution)', () => {
    const d = createExecutionDispatcher(parse);
    expect(() => d.feed({ type: 'skills_reloaded', ok: true })).not.toThrow();
  });

  it('with a session sink, an error event is delivered session-scoped even on a stale/absent executionId', () => {
    const seen: AgentEvent[] = [];
    const d = createExecutionDispatcher(parse, undefined, undefined, undefined, undefined, (ev) => seen.push(ev));
    // No registered execution, and a stale executionId — the legacy path would drop these.
    d.feed({ type: 'error', error: 'boom' });
    d.feed({ type: 'error', error: 'late', executionId: 'e-gone' });
    expect(seen).toEqual([{ type: 'error', error: 'boom' }, { type: 'error', error: 'late' }]);
  });

  it('a executionId-less status (account credit) is delivered session-scoped, not to any execution generator', async () => {
    const seen: AgentEvent[] = [];
    const d = createExecutionDispatcher(parse, undefined, undefined, undefined, undefined, (ev) => seen.push(ev));
    const gen = d.registerExecution('e-1', noopPerm);
    // Credit status carries no executionId → must reach the session sink so the
    // status bar updates outside any execution. A execution-scoped status still goes
    // to that execution's generator (the credit path must not steal it).
    d.feed({ type: 'status', executionId: 'e-1', state: 'idle' });
    d.feed({ type: 'status' }); // executionId-less → session sink
    expect(seen).toEqual([{ type: 'status', payload: { state: undefined } }]);

    const genEvents: AgentEvent[] = [];
    for await (const e of gen) genEvents.push(e);
    expect(genEvents).toContainEqual({ type: 'status', payload: { state: 'idle' } });
  });

  it('without a session sink, error still routes through the per-execution generator (legacy fallback)', async () => {
    const d = createExecutionDispatcher(parse);
    const gen = d.registerExecution('e-x', noopPerm);
    d.feed({ type: 'error', error: 'oops', executionId: 'e-x' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-x' });
    const events: AgentEvent[] = [];
    for await (const e of gen) events.push(e);
    expect(events.some((e) => e.type === 'error' && (e as any).error === 'oops')).toBe(true);
  });

  it('with a sink, message + stream are delivered session-scoped (in wire order), status stays on the generator', async () => {
    const seen: AgentEvent[] = [];
    const d = createExecutionDispatcher(parse, undefined, undefined, undefined, undefined, (ev) => seen.push(ev));
    const gen = d.registerExecution('e-1', noopPerm);
    // Interleave content (→ sink) with status (→ generator), all tagged t-1.
    d.feed({ type: 'stream', streamType: 'text', content: 'he', msgId: 'm1', executionId: 'e-1' });
    d.feed({ type: 'message', msgType: 'reply', content: 'hello', msgId: 'm1', executionId: 'e-1' });
    d.feed({ type: 'status', state: 'idle', executionId: 'e-1' });
    // A LATE message after the execution closed — legacy path would drop it; the sink delivers it.
    d.feed({ type: 'message', msgType: 'reply', content: 'tail', msgId: 'm2', executionId: 'e-1' });

    const genEvents: AgentEvent[] = [];
    for await (const e of gen) genEvents.push(e);

    // Content went to the sink in wire order (incl. the post-idle tail).
    expect(seen.map((e) => (e as any).payload.content)).toEqual(['he', 'hello', 'tail']);
    // The generator carried ONLY status (no message/stream).
    expect(genEvents.every((e) => e.type === 'status')).toBe(true);
  });
});
