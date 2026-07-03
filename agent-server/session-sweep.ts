// Phase-2 crash net: recover detached tasks orphaned by a DEAD agent-server (an
// ABNORMAL closure — a hard crash / force-kill that skipped the normal-closure
// reap). Each agent-server tags its own process env with SHELF_SESSION=<uuid>
// (inherited by every CLI + detached task it spawns) and drops a lease file. On
// the NEXT launch, a startup sweep finds leases whose owner is gone and kills the
// still-alive tasks still carrying that tag. A NORMAL shutdown removes its own
// lease (it already reaped), so only crashes leave a lease behind.
//
// Linux-only in effect (needs `/proc` to find/verify tagged processes); elsewhere
// the sweep still tidies stale lease files but kills nothing. See the
// `detached-task-reaping` design.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findPidsByEnv, procEnvHas, hasProcFs, killProcessGroup } from './proc-scan';

export const SESSION_ENV_KEY = 'SHELF_SESSION';

export interface SessionLease {
  /** The SHELF_SESSION uuid this agent-server stamped into its env. */
  session: string;
  /** The agent-server process that owns this session (liveness check). */
  ownerPid: number;
  createdAt: number;
}

export function sessionsDir(): string {
  return join(homedir(), '.shelf', 'agent-sessions');
}

export function writeLease(lease: SessionLease, dir = sessionsDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, `${lease.session}.json`), JSON.stringify(lease));
  } catch {
    /* best-effort — a missing lease only weakens crash recovery, never breaks a turn */
  }
}

export function removeLease(session: string, dir = sessionsDir()): void {
  try {
    fs.rmSync(join(dir, `${session}.json`), { force: true });
  } catch {
    /* best-effort */
  }
}

export function readLeases(dir = sessionsDir()): SessionLease[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionLease[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const l = JSON.parse(fs.readFileSync(join(dir, name), 'utf8'));
      if (l && typeof l.session === 'string' && typeof l.ownerPid === 'number') {
        out.push({ session: l.session, ownerPid: l.ownerPid, createdAt: Number(l.createdAt) || 0 });
      }
    } catch {
      /* skip malformed lease */
    }
  }
  return out;
}

/**
 * Is the lease's owning agent-server still alive? On Linux, precise +
 * pid-reuse-safe: the owner pid must STILL carry this exact session tag in its
 * environ (a reused pid won't). Off-Linux, coarse liveness via `process.kill(0)`
 * (no kill happens there anyway, so a false-positive only defers lease tidy-up).
 */
export function isOwnerAlive(lease: SessionLease, procRoot = '/proc'): boolean {
  if (hasProcFs(procRoot)) {
    return procEnvHas(lease.ownerPid, SESSION_ENV_KEY, lease.session, procRoot);
  }
  try {
    process.kill(lease.ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SessionSweepDeps {
  leases: SessionLease[];
  /** Live owner (this or a concurrent sibling agent-server) → leave it alone. */
  ownerAlive: (lease: SessionLease) => boolean;
  /** Live pids still carrying a dead session's tag. */
  findOrphans: (session: string) => number[];
  kill: (pid: number) => void;
  removeLease: (session: string) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Pure orchestration (deps injected → unit-testable without real /proc or kills):
 * for every lease whose owner is gone, kill the still-alive tagged orphans and
 * drop the lease. A live-owner lease is left untouched. Resilient — a throwing
 * kill on one orphan is logged and doesn't block the rest.
 */
export function runSessionSweep(deps: SessionSweepDeps): { sweptSessions: number; killed: number } {
  let sweptSessions = 0;
  let killed = 0;
  for (const lease of deps.leases) {
    if (deps.ownerAlive(lease)) continue;
    const orphans = deps.findOrphans(lease.session);
    for (const pid of orphans) {
      try {
        deps.kill(pid);
        killed++;
      } catch (err: any) {
        deps.log('error', `session-sweep: kill ${pid} failed: ${err?.message ?? err}`);
      }
    }
    deps.removeLease(lease.session);
    sweptSessions++;
    if (orphans.length) {
      deps.log('info', `session-sweep: reaped ${orphans.length} orphan task(s) from dead session ${lease.session}`);
    }
  }
  return { sweptSessions, killed };
}

/** Boot entry: wire the real /proc + lease deps and run the startup sweep. */
export function sweepDeadSessions(log: (level: 'info' | 'warn' | 'error', msg: string) => void): { sweptSessions: number; killed: number } {
  return runSessionSweep({
    leases: readLeases(),
    ownerAlive: (l) => isOwnerAlive(l),
    findOrphans: (session) => findPidsByEnv(SESSION_ENV_KEY, session),
    kill: killProcessGroup,
    removeLease: (session) => removeLease(session),
    log,
  });
}
