import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createDispatcherConnection, type DispatcherProc } from './dispatcher-connection';
import { MEMORY_PROCESS_ROLE, MEMORY_REPORT_STATUS, MEMORY_WIRE_TYPE } from '@shared/process-memory';

const logWarn = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
vi.mock('@shared/logger', () => ({ log: { info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() } }));

beforeEach(() => {
  logWarn.mockClear();
  logError.mockClear();
});

function fakeProc() {
  const written: string[] = [];
  let lineCb: ((l: string) => void) | undefined;
  let exitCb: ((c: number | null) => void) | undefined;
  const proc: DispatcherProc = {
    writeLine: (l) => written.push(l),
    onLine: (cb) => { lineCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: vi.fn(),
  };
  return {
    proc,
    written,
    parsedWritten: () => written.map((l) => JSON.parse(l)),
    emit: (obj: any) => lineCb!(JSON.stringify(obj)),
    exit: (code: number | null) => exitCb!(code),
  };
}

function make(overrides: Partial<Parameters<typeof createDispatcherConnection>[0]> = {}) {
  const f = fakeProc();
  const handleAppTool = vi.fn(async () => ({ ok: true, data: 'R' }));
  const conn = createDispatcherConnection({
    proc: f.proc,
    parseRemoteMessage: () => null, // we exercise dedicated sinks (queue/task), not execution parsing
    handleAppTool,
    heartbeatIntervalMs: 1_000_000, // effectively off for the test
    ...overrides,
  });
  return { f, conn, handleAppTool };
}

describe('dispatcher-connection (per-host demux by sid)', () => {
  const memoryReport = () => ({
    type: MEMORY_WIRE_TYPE.USAGE,
    status: MEMORY_REPORT_STATUS.OK,
    sampledAt: '2026-08-05T00:00:00.000Z',
    rows: [{ pid: 10, ppid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.DISPATCHER }],
  });

  it('openSession sends open_session with sid + cwd', () => {
    const { f, conn } = make();
    conn.openSession('s1', '/tmp/p', {});
    expect(f.parsedWritten()).toContainEqual({ type: 'open_session', sid: 's1', cwd: '/tmp/p' });
  });

  it('channel.sendLine stamps the sid', () => {
    const { f, conn } = make();
    const ch = conn.openSession('s1', undefined, {});
    ch.sendLine({ type: 'send', prompt: 'x' });
    expect(f.parsedWritten()).toContainEqual({ type: 'send', prompt: 'x', sid: 's1' });
  });

  it('requests host memory without a sid', () => {
    const { f, conn } = make();
    conn.requestMemoryUsage();
    expect(f.parsedWritten()).toContainEqual({ type: MEMORY_WIRE_TYPE.GET_USAGE });
  });

  it('routes a session event to the matching sid sink only', () => {
    const q1: any[] = []; const q2: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onQueue: (items) => q1.push(items) });
    conn.openSession('s2', undefined, { onQueue: (items) => q2.push(items) });
    f.emit({ type: 'queue', items: [{ a: 1 }], sid: 's2' });
    expect(q2).toHaveLength(1);
    expect(q1).toHaveLength(0);
  });

  it('routes host memory before the no-sid rejection branch', () => {
    const onMemoryUsage = vi.fn();
    const { f } = make({ onMemoryUsage });
    f.emit(memoryReport());
    expect(onMemoryUsage).toHaveBeenCalledWith(memoryReport());
  });

  it('routes a validated memory report only to its sid session sink', () => {
    const m1 = vi.fn(); const m2 = vi.fn();
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onMemoryUsage: m1 });
    conn.openSession('s2', undefined, { onMemoryUsage: m2 });
    f.emit({ ...memoryReport(), sid: 's2' });
    expect(m1).not.toHaveBeenCalled();
    expect(m2).toHaveBeenCalledWith(memoryReport());
  });

  it('logs an error instead of silently dropping a host report without a sink', () => {
    const { f } = make();
    f.emit(memoryReport());
    expect(logError).toHaveBeenCalledWith(
      'dispatcher-conn',
      'host memory report has no registered sink — dropped',
    );
  });

  it('logs an error instead of silently dropping a session report without a sink', () => {
    const { f, conn } = make();
    conn.openSession('s1', undefined, {});
    f.emit({ ...memoryReport(), sid: 's1' });
    expect(logError).toHaveBeenCalledWith(
      'dispatcher-conn',
      'session memory report sid=s1 has no registered sink — dropped',
    );
  });

  it('logs malformed and late memory routing at error/warn level', () => {
    const { f } = make();
    f.emit({ ...memoryReport(), sid: 7 });
    expect(logError).toHaveBeenCalledWith(
      'dispatcher-conn',
      'memory report has invalid sid type=number — dropped',
    );

    f.emit({ ...memoryReport(), sid: 'gone' });
    expect(logWarn).toHaveBeenCalledWith(
      'dispatcher-conn',
      'late session memory report sid=gone — dropped',
    );
  });

  it('rejects late host reports after the dispatcher handle is killed', () => {
    const onMemoryUsage = vi.fn();
    const { f, conn } = make({ onMemoryUsage });
    conn.kill();
    f.emit(memoryReport());
    expect(onMemoryUsage).not.toHaveBeenCalled();
  });

  it('drops a line for an unknown sid', () => {
    const q1: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onQueue: (items) => q1.push(items) });
    f.emit({ type: 'queue', items: [{ a: 1 }], sid: 'ghost' });
    expect(q1).toHaveLength(0);
  });

  it('handles app_tool with the sid session projectId and replies with sid', async () => {
    const { f, conn, handleAppTool } = make();
    conn.openSession('s1', undefined, { projectId: 'proj-1' });
    f.emit({ type: 'app_tool', sid: 's1', requestId: 'r1', op: 'web.fetch', args: { url: 'u' } });
    expect(handleAppTool).toHaveBeenCalledWith('web.fetch', { url: 'u' }, { projectId: 'proj-1' });
    await Promise.resolve(); await Promise.resolve();
    expect(f.parsedWritten()).toContainEqual({ type: 'app_tool_result', sid: 's1', requestId: 'r1', ok: true, data: 'R' });
  });

  it('emits an Agent View audit card for worktree app_tool args and result', async () => {
    const events: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { projectId: 'proj-1', onSessionEvent: (ev) => events.push(ev) });

    f.emit({
      type: 'app_tool',
      sid: 's1',
      requestId: 'r1',
      op: 'worktree.propose_create',
      args: { branch: 'feature/x', note: '.agent/features/x.md' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      payload: {
        msgId: 'app-tool-r1',
        type: 'fold_code',
        label: 'Shelf tool',
        subtitle: 'propose_worktree_create',
      },
    });
    expect(events[0].payload.body.content).toContain('"note": ".agent/features/x.md"');

    await Promise.resolve(); await Promise.resolve();
    expect(events).toHaveLength(2);
    expect(events[1].payload.msgId).toBe('app-tool-r1');
    expect(events[1].payload.body.content).toContain('"result":');
  });

  it('marks a sid dead only on a TERMINAL session_down (willReconnect:false)', () => {
    const h1: any[] = []; const h2: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onHealth: (h) => h1.push(h) });
    conn.openSession('s2', undefined, { onHealth: (h) => h2.push(h) });
    f.emit({ type: 'session_down', sid: 's1', reason: 'x', willReconnect: false });
    // openSession seeds an initial 'healthy'; the terminal down then flips s1 to dead.
    expect(h1.at(-1)).toEqual({ state: 'dead' });
    expect(h2).not.toContainEqual({ state: 'dead' }); // sibling untouched
  });

  it('does NOT flap a sid to dead while it is reconnecting (willReconnect:true)', () => {
    const h1: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onHealth: (h) => h1.push(h) });
    f.emit({ type: 'session_down', sid: 's1', reason: 'crash', willReconnect: true });
    expect(h1).not.toContainEqual({ state: 'dead' }); // reconnecting; host heartbeat stands
  });

  it('fails in-flight executions loud on session_down (error then idle end the generator)', async () => {
    const { f, conn } = make();
    const ch = conn.openSession('s1', undefined, {});
    const gen = ch.registerExecution('t1', () => {});
    f.emit({ type: 'session_down', sid: 's1', reason: 'exited (code 1)', willReconnect: true });
    // The execution generator yields the fail-loud error, then ends (idle).
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'error' });
    expect(String((first.value as any).error)).toContain('interrupted');
    // drains to completion (idle ended it)
    let done = false;
    for (let i = 0; i < 5 && !done; i++) { const r = await gen.next(); done = !!r.done; }
    expect(done).toBe(true);
  });

  it('proc exit marks every session dead and clears channels', () => {
    const h1: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onHealth: (h) => h1.push(h) });
    f.exit(1);
    expect(h1).toContainEqual({ state: 'dead' });
    expect(conn.size()).toBe(0);
  });

  it('channel.kill sends close_session and fires onEmpty on the last session', () => {
    const onEmpty = vi.fn();
    const { f, conn } = make({ onEmpty });
    const a = conn.openSession('s1', undefined, {});
    const b = conn.openSession('s2', undefined, {});
    a.kill();
    expect(f.parsedWritten()).toContainEqual({ type: 'close_session', sid: 's1' });
    expect(onEmpty).not.toHaveBeenCalled(); // s2 still open
    b.kill();
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(conn.size()).toBe(0);
  });

  it('re-opening an already-open sid replaces cleanly (close old → open fresh); stale kill is a no-op — regression', () => {
    // Close/reopen race on a per-project persistent sid: the restart must send
    // close_session THEN open_session, and the orphaned old channel's kill must NOT
    // close the new session's exec (Map<sid> collision → "Failed to start agent-server").
    const { f, conn } = make();
    const ch1 = conn.openSession('s1', '/p', {});
    f.written.length = 0;
    const ch2 = conn.openSession('s1', '/p', {}); // re-init same sid
    expect(f.parsedWritten()).toEqual([
      { type: 'close_session', sid: 's1' },
      { type: 'open_session', sid: 's1', cwd: '/p' },
    ]);
    // The STALE channel's kill is a no-op (ch2 owns the sid now).
    f.written.length = 0;
    ch1.kill();
    expect(f.parsedWritten()).toHaveLength(0);
    // ch2's kill DOES close.
    ch2.kill();
    expect(f.parsedWritten()).toContainEqual({ type: 'close_session', sid: 's1' });
  });

  it('seeds a healthy status on openSession so a reconnect clears a stale red — regression', () => {
    // Bug: after a dispatcher crash the tab sat at 'dead' (red). On reconnect the
    // new connection never emitted 'healthy' (heartbeat only emits on change from
    // healthy), so the red never cleared even though caps re-init succeeded.
    const onHealth = vi.fn();
    const { conn } = make();
    conn.openSession('s1', undefined, { onHealth });
    expect(onHealth).toHaveBeenCalledWith(expect.objectContaining({ state: 'healthy' }));
  });

  it('fires onDown when the dispatcher proc exits (owner evicts the dead conn) — regression', () => {
    // Bug: on a dispatcher crash the dead conn lingered in the owner's per-host map,
    // so the next connect "reused" the corpse → openSession wrote to a closed stdin
    // → caps init failed ("Failed to start agent-server") instead of spawning fresh.
    const onDown = vi.fn();
    const onHealth = vi.fn();
    const { f, conn } = make({ onDown });
    conn.openSession('s1', undefined, { onHealth });
    f.exit(null); // dispatcher proc killed
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onHealth).toHaveBeenCalledWith({ state: 'dead' }); // the tab also goes dead
    expect(conn.size()).toBe(0);
  });

  it('ignores the dispatcher-level ready (no sid)', () => {
    const q1: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onQueue: (i) => q1.push(i) });
    f.emit({ type: 'ready' }); // no sid → dispatcher up, not a session signal
    expect(q1).toHaveLength(0);
  });
});
