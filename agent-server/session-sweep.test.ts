import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeLease, readLeases, removeLease, isOwnerAlive, runSessionSweep, type SessionLease } from './session-sweep';

describe('session leases', () => {
  let dir: string;
  beforeEach(() => { dir = join(tmpdir(), `shelf-sessions-${randomUUID()}`); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes, reads back, and removes a lease', () => {
    const lease: SessionLease = { session: 'sess-1', ownerPid: 1234, createdAt: 111 };
    writeLease(lease, dir);
    expect(readLeases(dir)).toEqual([lease]);
    removeLease('sess-1', dir);
    expect(readLeases(dir)).toEqual([]);
  });

  it('readLeases skips malformed / non-lease files', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'a.json'), 'not json');
    fs.writeFileSync(join(dir, 'b.json'), JSON.stringify({ session: 'ok', ownerPid: 5, createdAt: 1 }));
    fs.writeFileSync(join(dir, 'c.txt'), 'ignored (not .json)');
    fs.writeFileSync(join(dir, 'd.json'), JSON.stringify({ nope: true }));
    expect(readLeases(dir)).toEqual([{ session: 'ok', ownerPid: 5, createdAt: 1 }]);
  });

  it('readLeases returns [] for a missing dir', () => {
    expect(readLeases(join(dir, 'nope'))).toEqual([]);
  });
});

describe('isOwnerAlive (fake /proc)', () => {
  let procRoot: string;
  beforeEach(() => { procRoot = join(tmpdir(), `shelf-proc-${randomUUID()}`); fs.mkdirSync(procRoot, { recursive: true }); });
  afterEach(() => { fs.rmSync(procRoot, { recursive: true, force: true }); });

  function writeEnviron(pid: number, env: Record<string, string>): void {
    const d = join(procRoot, String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(join(d, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
  }

  it('alive iff the owner pid still carries THIS session tag (pid-reuse-safe)', () => {
    writeEnviron(1234, { SHELF_SESSION: 'sess-1' });
    expect(isOwnerAlive({ session: 'sess-1', ownerPid: 1234, createdAt: 0 }, procRoot)).toBe(true);
    // pid reused by a process WITHOUT our tag → treated as dead
    writeEnviron(2345, { SHELF_SESSION: 'someone-else' });
    expect(isOwnerAlive({ session: 'sess-1', ownerPid: 2345, createdAt: 0 }, procRoot)).toBe(false);
    // pid gone → dead
    expect(isOwnerAlive({ session: 'sess-1', ownerPid: 9999, createdAt: 0 }, procRoot)).toBe(false);
  });
});

describe('runSessionSweep', () => {
  it('sweeps dead-owner sessions (kill orphans + drop lease); leaves live owners', () => {
    const kill = vi.fn();
    const removed: string[] = [];
    const res = runSessionSweep({
      leases: [
        { session: 'dead', ownerPid: 1, createdAt: 0 },
        { session: 'live', ownerPid: 2, createdAt: 0 },
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
      leases: [{ session: 'dead', ownerPid: 1, createdAt: 0 }],
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
      leases: [{ session: 'dead', ownerPid: 1, createdAt: 0 }],
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
