import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeLease, readLeases, removeLease, isOwnerAlive, runSessionSweep, SESSION_ENV_KEY, type SessionLease } from './session-sweep';
import { findPidsByEnv, readProcStartTime, killProcessGroup } from './proc-scan';

describe('session leases', () => {
  let dir: string;
  beforeEach(() => { dir = join(tmpdir(), `shelf-sessions-${randomUUID()}`); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes, reads back, and removes a lease', () => {
    const lease: SessionLease = { session: 'sess-1', ownerPid: 1234, ownerStartTime: 42, createdAt: 111 };
    writeLease(lease, dir);
    expect(readLeases(dir)).toEqual([lease]);
    removeLease('sess-1', dir);
    expect(readLeases(dir)).toEqual([]);
  });

  it('readLeases skips malformed / non-lease files and defaults ownerStartTime', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'a.json'), 'not json');
    fs.writeFileSync(join(dir, 'b.json'), JSON.stringify({ session: 'ok', ownerPid: 5, createdAt: 1 }));
    fs.writeFileSync(join(dir, 'c.txt'), 'ignored (not .json)');
    fs.writeFileSync(join(dir, 'd.json'), JSON.stringify({ nope: true }));
    expect(readLeases(dir)).toEqual([{ session: 'ok', ownerPid: 5, ownerStartTime: null, createdAt: 1 }]);
  });

  it('readLeases returns [] for a missing dir', () => {
    expect(readLeases(join(dir, 'nope'))).toEqual([]);
  });
});

describe('isOwnerAlive (fake /proc, start-time identity)', () => {
  let procRoot: string;
  beforeEach(() => { procRoot = join(tmpdir(), `shelf-proc-${randomUUID()}`); fs.mkdirSync(procRoot, { recursive: true }); });
  afterEach(() => { fs.rmSync(procRoot, { recursive: true, force: true }); });

  // /proc/<pid>/stat with `startTime` at field 22 (index 19 after the ')').
  function writeStat(pid: number, startTime: number): void {
    const d = join(procRoot, String(pid));
    fs.mkdirSync(d, { recursive: true });
    const post = ['S', ...Array(18).fill('0'), String(startTime)]; // 20 tokens, index 19 = startTime
    fs.writeFileSync(join(d, 'stat'), `${pid} (agent server) ${post.join(' ')} 0 0 0`);
  }

  it('alive iff the owner pid exists AND its start-time matches (pid-reuse-safe)', () => {
    writeStat(1234, 555);
    expect(isOwnerAlive({ session: 's', ownerPid: 1234, ownerStartTime: 555, createdAt: 0 }, procRoot)).toBe(true);
    // pid reused → same pid, DIFFERENT start-time → dead
    expect(isOwnerAlive({ session: 's', ownerPid: 1234, ownerStartTime: 999, createdAt: 0 }, procRoot)).toBe(false);
    // pid gone → dead
    expect(isOwnerAlive({ session: 's', ownerPid: 9999, ownerStartTime: 555, createdAt: 0 }, procRoot)).toBe(false);
  });
});

describe('runSessionSweep', () => {
  it('sweeps dead-owner sessions (kill orphans + drop lease); leaves live owners', () => {
    const kill = vi.fn();
    const removed: string[] = [];
    const res = runSessionSweep({
      leases: [
        { session: 'dead', ownerPid: 1, ownerStartTime: null, createdAt: 0 },
        { session: 'live', ownerPid: 2, ownerStartTime: null, createdAt: 0 },
      ],
      ownerAlive: (l) => l.session === 'live',
      findOrphans: (s) => (s === 'dead' ? [100, 101] : []),
      kill,
      removeLease: (s) => removed.push(s),
      log: () => {},
    });
    expect(kill).toHaveBeenCalledWith(100);
    expect(kill).toHaveBeenCalledWith(101);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(removed).toEqual(['dead']);
    expect(res).toEqual({ sweptSessions: 1, killed: 2 });
  });

  it('a throwing kill on one orphan does not block the rest', () => {
    const kill = vi.fn((pid: number) => { if (pid === 100) throw new Error('boom'); });
    const log = vi.fn();
    const res = runSessionSweep({
      leases: [{ session: 'dead', ownerPid: 1, ownerStartTime: null, createdAt: 0 }],
      ownerAlive: () => false,
      findOrphans: () => [100, 101],
      kill,
      removeLease: () => {},
      log,
    });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(res.killed).toBe(1);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('kill 100 failed'));
  });

  it('a dead session with no orphans still drops its lease', () => {
    const removed: string[] = [];
    const res = runSessionSweep({
      leases: [{ session: 'dead', ownerPid: 1, ownerStartTime: null, createdAt: 0 }],
      ownerAlive: () => false,
      findOrphans: () => [],
      kill: () => {},
      removeLease: (s) => removed.push(s),
      log: () => {},
    });
    expect(removed).toEqual(['dead']);
    expect(res).toEqual({ sweptSessions: 1, killed: 0 });
  });
});

// Real end-to-end crash-net path against the REAL /proc + REAL processes — mirrors
// the manual docker verification. Runs on Linux CI, skipped where /proc is absent.
// This is the regression that would have caught the runtime-env-vs-/proc/environ
// bug (a live owner must NOT be swept — verified via start-time identity).
describe.skipIf(process.platform !== 'linux')('session sweep (real /proc, linux only)', () => {
  function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !isAlive(pid);
  }
  function spawnTagged(uuid: string): number {
    const c = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, [SESSION_ENV_KEY]: uuid } });
    c.unref();
    return c.pid!;
  }

  it('reaps a crashed session\'s orphan but NOT a live session\'s task', async () => {
    // Crashed session: a definitely-dead owner pid + its live tagged orphan.
    const deadUuid = randomUUID();
    const orphan = spawnTagged(deadUuid);
    const dyer = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    const deadPid = dyer.pid!;
    const deadStart = readProcStartTime(deadPid);
    process.kill(deadPid, 'SIGKILL');
    await waitDead(deadPid);

    // Live session: an alive owner + its tagged task (must survive).
    const liveUuid = randomUUID();
    const liveTask = spawnTagged(liveUuid);
    const owner = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    owner.unref();
    const ownerPid = owner.pid!;
    const ownerStart = readProcStartTime(ownerPid);

    const removed: string[] = [];
    try {
      const res = runSessionSweep({
        leases: [
          { session: deadUuid, ownerPid: deadPid, ownerStartTime: deadStart, createdAt: 0 },
          { session: liveUuid, ownerPid: ownerPid, ownerStartTime: ownerStart, createdAt: 0 },
        ],
        ownerAlive: (l) => isOwnerAlive(l),
        findOrphans: (s) => findPidsByEnv(SESSION_ENV_KEY, s),
        kill: killProcessGroup,
        removeLease: (s) => removed.push(s),
        log: () => {},
      });
      expect(await waitDead(orphan)).toBe(true); // crashed orphan reaped
      expect(isAlive(liveTask)).toBe(true);      // live task untouched
      expect(res.sweptSessions).toBe(1);
      expect(removed).toEqual([deadUuid]);
    } finally {
      for (const p of [orphan, liveTask, ownerPid]) {
        try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ }
        try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  });
});
