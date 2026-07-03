// Linux `/proc` primitives for the Phase-2 crash net: find and kill detached
// tasks left behind by a DEAD agent-server, matched by an inherited env tag
// (SHELF_SESSION). Linux-only in practice — `/proc/<pid>/environ` exposes a
// process's env, same-uid readable, no privilege. On macOS/Windows there is no
// `/proc`, so the readers return empty and the whole crash net no-ops (documented
// limitation — see the `detached-task-reaping` design). `procRoot` is injectable
// so the parsing/matching is unit-testable off-Linux against a fake tree.
import * as fs from 'node:fs';
import { join } from 'node:path';

/** A process's env entries ("KEY=VALUE") from /proc/<pid>/environ, or null if
 *  unreadable (no /proc, EACCES for another uid, process gone). */
export function readProcEnviron(pid: number, procRoot = '/proc'): string[] | null {
  try {
    const raw = fs.readFileSync(join(procRoot, String(pid), 'environ'), 'utf8');
    return raw.split('\0').filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/** Does /proc/<pid> carry exactly `KEY=VALUE` in its environ? */
export function procEnvHas(pid: number, key: string, value: string, procRoot = '/proc'): boolean {
  const entries = readProcEnviron(pid, procRoot);
  return entries != null && entries.includes(`${key}=${value}`);
}

/** All live pids whose environ carries `KEY=VALUE`. Walks numeric /proc/<pid>
 *  dirs. Returns [] where /proc is absent (macOS/Windows) or unreadable. */
export function findPidsByEnv(key: string, value: string, procRoot = '/proc'): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (procEnvHas(pid, key, value, procRoot)) out.push(pid);
  }
  return out;
}

/** Does a `/proc` filesystem exist here (≈ "are we on Linux")? */
export function hasProcFs(procRoot = '/proc'): boolean {
  try {
    return fs.existsSync(procRoot);
  } catch {
    return false;
  }
}

/** SIGTERM a detached task's whole process GROUP (it `setsid`'d → session/group
 *  leader, pgid == pid), falling back to the bare pid. Best-effort. */
export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
