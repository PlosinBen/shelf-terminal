import { describe, it, expect, vi } from 'vitest';
import { createDispatcher, type ExecProc } from './dispatcher';

// A fake exec proc that records forwarded lines / kills and exposes the hooks the
// dispatcher wired, so tests can drive exec→main (onLine) and exit (onExit).
function harness(opts: { now?: () => number } = {}) {
  const toMain: string[] = [];
  const logs: Array<[string, string]> = [];
  const spawned: Array<{
    sid: string;
    cwd: string | undefined;
    hooks: { onLine: (l: string) => void; onExit: (c: number | null) => void };
    written: string[];
    killed: number;
  }> = [];

  const spawnExec = vi.fn((sid: string, cwd: string | undefined, hooks: any): ExecProc => {
    const rec = { sid, cwd, hooks, written: [] as string[], killed: 0 };
    spawned.push(rec);
    return { writeLine: (l: string) => rec.written.push(l), kill: () => { rec.killed++; } };
  });

  const d = createDispatcher({
    spawnExec,
    sendToMain: (l) => toMain.push(l),
    log: (lvl, m) => logs.push([lvl, m]),
    now: opts.now,
  });
  const parsedToMain = () => toMain.map((l) => JSON.parse(l));
  return { d, toMain, parsedToMain, logs, spawned, spawnExec };
}

describe('dispatcher core', () => {
  it('open_session spawns an exec proc with sid + cwd', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1', cwd: '/tmp/p' }));
    expect(h.spawnExec).toHaveBeenCalledTimes(1);
    expect(h.spawned[0]).toMatchObject({ sid: 's1', cwd: '/tmp/p' });
  });

  it('relays exec stdout lines to main RAW (exec already stamped sid)', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1' }));
    const raw = '{"type":"message","sid":"s1","msgType":"reply","content":"hi"}';
    h.spawned[0].hooks.onLine(raw);
    expect(h.toMain).toContain(raw); // byte-identical, not re-serialized
  });

  it('routes a session message to the matching exec, forwarding the original line', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1' }));
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's2' }));
    const sendLine = JSON.stringify({ type: 'send', sid: 's2', prompt: 'go', cwd: '/x' });
    h.d.onMainLine(sendLine);
    expect(h.spawned[0].written).toHaveLength(0); // s1 untouched
    expect(h.spawned[1].written).toEqual([sendLine]); // s2 got it verbatim
  });

  it('drops a session message for an unknown sid (fail-loud log, nothing forwarded)', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'stop_task', sid: 'ghost', taskId: 't' }));
    expect(h.logs.some(([lvl]) => lvl === 'warn')).toBe(true);
    expect(h.toMain).toHaveLength(0);
  });

  it('close_session kills and forgets the exec proc', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1' }));
    h.d.onMainLine(JSON.stringify({ type: 'close_session', sid: 's1' }));
    expect(h.spawned[0].killed).toBe(1);
    // a subsequent message for s1 is now unknown → dropped
    h.d.onMainLine(JSON.stringify({ type: 'send', sid: 's1', prompt: 'x' }));
    expect(h.spawned[0].written).toHaveLength(0);
  });

  it('ping → pong (dispatcher-level, no sid)', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'ping', seq: 7 }));
    expect(h.parsedToMain()).toContainEqual({ type: 'pong', seq: 7 });
  });

  it('exec exit auto-respawns (willRespawn:true) and starts a fresh exec', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1', cwd: '/w' }));
    expect(h.spawnExec).toHaveBeenCalledTimes(1);
    h.spawned[0].hooks.onExit(1);
    const down = h.parsedToMain().find((m) => m.type === 'session_down');
    expect(down).toMatchObject({ sid: 's1', willRespawn: true });
    expect(h.spawnExec).toHaveBeenCalledTimes(2); // respawned with the same cwd
    expect(h.spawned[1]).toMatchObject({ sid: 's1', cwd: '/w' });
  });

  it('gives up (willRespawn:false) when an exec crash-loops past the backoff cap', () => {
    let t = 0;
    const h = harness({ now: () => t });
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1' }));
    for (let i = 0; i < 6; i++) {
      h.spawned[h.spawned.length - 1].hooks.onExit(1); // crash the latest exec
      t += 100; // all within RESPAWN_WINDOW_MS
    }
    const downs = h.parsedToMain().filter((m) => m.type === 'session_down');
    expect(downs.filter((d) => d.willRespawn === true)).toHaveLength(5); // 5 respawns
    expect(downs[downs.length - 1]).toMatchObject({ willRespawn: false }); // then give up
  });

  it('does NOT respawn after an intentional close_session', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1' }));
    h.d.onMainLine(JSON.stringify({ type: 'close_session', sid: 's1' }));
    // kill() fired; a stale exit for a closed sid must not respawn.
    h.spawned[0].hooks.onExit(0);
    expect(h.spawnExec).toHaveBeenCalledTimes(1);
  });

  it('drops non-JSON lines from main', () => {
    const h = harness();
    h.d.onMainLine('not json');
    expect(h.logs.some(([lvl]) => lvl === 'warn')).toBe(true);
    expect(h.spawnExec).not.toHaveBeenCalled();
  });

  it('shutdown kills all exec procs', () => {
    const h = harness();
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's1' }));
    h.d.onMainLine(JSON.stringify({ type: 'open_session', sid: 's2' }));
    h.d.shutdown();
    expect(h.spawned[0].killed).toBe(1);
    expect(h.spawned[1].killed).toBe(1);
  });
});
