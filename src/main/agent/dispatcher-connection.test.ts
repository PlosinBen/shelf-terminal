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

  it('surfaces dead health to only that sid on session_down', () => {
    const h1: any[] = []; const h2: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onHealth: (h) => h1.push(h) });
    conn.openSession('s2', undefined, { onHealth: (h) => h2.push(h) });
    f.emit({ type: 'session_down', sid: 's1', reason: 'x', willRespawn: false });
    expect(h1).toEqual([{ state: 'dead' }]);
    expect(h2).toHaveLength(0);
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

  it('ignores the dispatcher-level ready (no sid)', () => {
    const q1: any[] = [];
    const { f, conn } = make();
    conn.openSession('s1', undefined, { onQueue: (i) => q1.push(i) });
    f.emit({ type: 'ready' }); // no sid → dispatcher up, not a session signal
    expect(q1).toHaveLength(0);
  });
});
