import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pidPathForLog, killDetachedByPidFile } from './pid-kill';

const silent = () => {};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

describe('pidPathForLog', () => {
  it('maps a .log path to its sibling .pid path', () => {
    expect(pidPathForLog('/tmp/tasks/abc.log')).toBe('/tmp/tasks/abc.pid');
  });
  it('leaves a non-.log path unchanged', () => {
    expect(pidPathForLog('/tmp/tasks/abc')).toBe('/tmp/tasks/abc');
  });
});

describe('killDetachedByPidFile', () => {
  it('kills a live detached process recorded in the pid file', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);
    const pidPath = join(tmpdir(), `shelf-reap-${randomUUID()}.pid`);
    await fs.writeFile(pidPath, String(pid));
    try {
      const killed = await killDetachedByPidFile(pidPath, silent);
      expect(killed).toBe(true);
      expect(await waitDead(pid)).toBe(true);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      await fs.rm(pidPath, { force: true });
    }
  });

  it('returns false when the pid file is missing (benign)', async () => {
    const missing = join(tmpdir(), `shelf-reap-missing-${randomUUID()}.pid`);
    expect(await killDetachedByPidFile(missing, silent)).toBe(false);
  });

  it('returns false and warns on a malformed pid', async () => {
    const logs: Array<[string, string]> = [];
    const pidPath = join(tmpdir(), `shelf-reap-bad-${randomUUID()}.pid`);
    await fs.writeFile(pidPath, 'not-a-pid');
    try {
      const killed = await killDetachedByPidFile(pidPath, (l, m) => logs.push([l, m]));
      expect(killed).toBe(false);
      expect(logs.some(([l]) => l === 'warn')).toBe(true);
    } finally {
      await fs.rm(pidPath, { force: true });
    }
  });

  it('returns false when the recorded pid is already dead', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    process.kill(pid, 'SIGKILL');
    await waitDead(pid);
    const pidPath = join(tmpdir(), `shelf-reap-dead-${randomUUID()}.pid`);
    await fs.writeFile(pidPath, String(pid));
    try {
      expect(await killDetachedByPidFile(pidPath, silent)).toBe(false);
    } finally {
      await fs.rm(pidPath, { force: true });
    }
  });
});
