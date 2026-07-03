import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readProcEnviron, procEnvHas, findPidsByEnv, hasProcFs, killProcessGroup, readProcStartTime } from './proc-scan';

// Build a fake /proc: <root>/<pid>/environ with NUL-delimited KEY=VALUE entries.
function writeEnviron(root: string, pid: number, env: Record<string, string>): void {
  const dir = join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const buf = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
  fs.writeFileSync(join(dir, 'environ'), buf);
}

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

describe('proc-scan (fake /proc)', () => {
  let root: string;
  beforeEach(() => { root = join(tmpdir(), `shelf-proc-${randomUUID()}`); fs.mkdirSync(root, { recursive: true }); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('readProcEnviron parses NUL-delimited env', () => {
    writeEnviron(root, 100, { SHELF_SESSION: 'abc', PATH: '/bin' });
    expect(readProcEnviron(100, root)).toEqual(['SHELF_SESSION=abc', 'PATH=/bin']);
  });

  it('readProcEnviron returns null when unreadable', () => {
    expect(readProcEnviron(999, root)).toBeNull();
  });

  it('procEnvHas matches an exact KEY=VALUE', () => {
    writeEnviron(root, 100, { SHELF_SESSION: 'abc' });
    expect(procEnvHas(100, 'SHELF_SESSION', 'abc', root)).toBe(true);
    expect(procEnvHas(100, 'SHELF_SESSION', 'xyz', root)).toBe(false);
    expect(procEnvHas(200, 'SHELF_SESSION', 'abc', root)).toBe(false);
  });

  it('findPidsByEnv finds all pids carrying the tag, ignoring non-numeric dirs', () => {
    writeEnviron(root, 100, { SHELF_SESSION: 'abc' });
    writeEnviron(root, 200, { SHELF_SESSION: 'abc' });
    writeEnviron(root, 300, { SHELF_SESSION: 'other' });
    fs.mkdirSync(join(root, 'notapid'), { recursive: true });
    expect(findPidsByEnv('SHELF_SESSION', 'abc', root).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it('findPidsByEnv returns [] when the proc root is absent (macOS/Windows)', () => {
    expect(findPidsByEnv('SHELF_SESSION', 'abc', join(root, 'nope'))).toEqual([]);
  });

  it('hasProcFs reflects existence', () => {
    expect(hasProcFs(root)).toBe(true);
    expect(hasProcFs(join(root, 'nope'))).toBe(false);
  });

  it('readProcStartTime parses field 22, even when comm contains spaces/parens', () => {
    const post = ['S', ...Array(18).fill('0'), '778899']; // index 19 = starttime
    fs.mkdirSync(join(root, '100'), { recursive: true });
    fs.writeFileSync(join(root, '100', 'stat'), `100 (weird (comm) name) ${post.join(' ')} 0 0`);
    expect(readProcStartTime(100, root)).toBe(778899);
  });

  it('readProcStartTime returns null when unreadable', () => {
    expect(readProcStartTime(999, root)).toBeNull();
  });
});

describe('killProcessGroup (real process)', () => {
  it('SIGTERMs a live detached process', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);
    try {
      killProcessGroup(pid);
      expect(await waitDead(pid)).toBe(true);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });
});

// Real end-to-end crash-net path against the REAL /proc — the piece that can't be
// exercised on macOS (no /proc). Runs on Linux CI, skipped elsewhere.
describe.skipIf(process.platform !== 'linux')('crash-net path (real /proc, linux only)', () => {
  it('finds a detached process by its inherited SHELF_SESSION tag and kills it', async () => {
    const tag = randomUUID();
    const child = spawn('sleep', ['30'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SHELF_SESSION: tag },
    });
    child.unref();
    const pid = child.pid!;
    try {
      const found = findPidsByEnv('SHELF_SESSION', tag); // real /proc
      expect(found).toContain(pid);
      killProcessGroup(pid);
      expect(await waitDead(pid)).toBe(true);
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });
});
