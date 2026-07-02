// Copilot has NO stop-task RPC. Its detached background bash records its own PID
// via `echo $$ > '<logPath .log→.pid>'` and is spawned `detached:true` (session/
// group leader). So the only way to reap such an escaped task while the session
// is alive is to read that pid file and signal the process. Kept in its own tiny
// module (I/O + process.kill — NOT pure) so it stays out of the pure `helpers.ts`
// and is unit-testable in isolation. See the `detached-task-reaping` design.
import { promises as fs } from 'node:fs';
import { serverLog, type ServerLogLevel } from '../../server-logger';

type Logger = (level: ServerLogLevel, msg: string) => void;
const defaultLog: Logger = (level, msg) => serverLog(level, 'copilot', msg);

/** Copilot writes the pid beside the log: `<...>.log` → `<...>.pid`. Pure. */
export function pidPathForLog(logPath: string): string {
  return logPath.replace(/\.log$/, '.pid');
}

/**
 * Reap a Copilot detached task by the pid recorded in `pidPath`. Signals the
 * whole process GROUP (`-pid`) — the detached task is a session/group leader, so
 * this also kills any children it spawned — falling back to the bare pid.
 *
 * Best-effort: a missing/unreadable file or an already-dead pid is benign (the
 * task never detached or is already gone) → debug-log, return false. A malformed
 * pid or a failed signal to a live process is an anomaly → warn (fail-loud).
 *
 * PID-reuse safety is intentionally LIGHT (a `kill(pid,0)` liveness check): the
 * `.pid` file is written THIS session, so reuse over a tab's lifetime is
 * negligible. The heavy start-time guard belongs to the Phase-2 crash net, which
 * reads pid files from PRIOR sessions off disk.
 *
 * @returns true iff a terminating signal was delivered.
 */
export async function killDetachedByPidFile(pidPath: string, log: Logger = defaultLog): Promise<boolean> {
  let raw: string;
  try {
    raw = (await fs.readFile(pidPath, 'utf8')).trim();
  } catch (err: any) {
    log('debug', `reap: no readable pid file ${pidPath}: ${err?.message ?? err}`);
    return false;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 1) {
    log('warn', `reap: invalid pid ${JSON.stringify(raw)} in ${pidPath}`);
    return false;
  }
  // Already gone → nothing to reap (benign).
  try {
    process.kill(pid, 0);
  } catch {
    log('debug', `reap: pid ${pid} already gone (${pidPath})`);
    return false;
  }
  // Detached → its own process group (pgid == pid). Negative pid signals the
  // group, reaping children too; fall back to the bare pid if the group is gone.
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch (err: any) {
      log('warn', `reap: kill pid ${pid} failed: ${err?.message ?? err}`);
      return false;
    }
  }
}
