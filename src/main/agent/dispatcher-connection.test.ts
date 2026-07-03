import { describe, it, expect, vi } from 'vitest';
import { createDispatcherConnection, type DispatcherProc } from './dispatcher-connection';

vi.mock('@shared/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

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
    parseRemoteMessage: () => null, // we exercise dedicated sinks (queue/task), not turn parsing
    handleAppTool,
    heartbeatIntervalMs: 1_000_000, // effectively off for the test
    ...overrides,
  });
  return { f, conn, handleAppTool };
}

describe('dispatcher-connection (per-host demux by sid)', () => {
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

  it('routes a session event to the matching sid sink only', () => {
    const q1: any[] = []; const q2: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onQueue: (items) => q1.push(items) });
    conn.openSession('s2', undefined, { onQueue: (items) => q2.push(items) });
    f.emit({ type: 'queue', items: [{ a: 1 }], sid: 's2' });
    expect(q2).toHaveLength(1);
    expect(q1).toHaveLength(0);
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

  it('marks a sid dead only on a TERMINAL session_down (willReconnect:false)', () => {
    const h1: any[] = []; const h2: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onHealth: (h) => h1.push(h) });
    conn.openSession('s2', undefined, { onHealth: (h) => h2.push(h) });
    f.emit({ type: 'session_down', sid: 's1', reason: 'x', willReconnect: false });
    expect(h1).toEqual([{ state: 'dead' }]);
    expect(h2).toHaveLength(0);
  });

  it('does NOT flap a sid to dead while it is reconnecting (willReconnect:true)', () => {
    const h1: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onHealth: (h) => h1.push(h) });
    f.emit({ type: 'session_down', sid: 's1', reason: 'crash', willReconnect: true });
    expect(h1).toHaveLength(0); // reconnecting; host heartbeat stands
  });

  it('fails in-flight turns loud on session_down (error then idle end the generator)', async () => {
    const { f, conn } = make();
    const ch = conn.openSession('s1', undefined, {});
    const gen = ch.registerTurn('t1', () => {});
    f.emit({ type: 'session_down', sid: 's1', reason: 'exited (code 1)', willReconnect: true });
    // The turn generator yields the fail-loud error, then ends (idle).
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
