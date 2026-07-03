// The single NORMAL-closure path for agent-server: reap escaped detached tasks,
// then dispose every backend, then exit. Invoked from BOTH the stdin-close handler
// (tab close / app quit / main crash / SSH pipe break) AND the idle watchdog (ssh
// no-ping self-exit). It ALWAYS reaps — while agent-server is alive a closure is a
// real end of the session (there is no reconnect: a reconnect is a new connection),
// so a surviving detached task would be a permanently invisible orphan. The only
// closure that never reaches here is ABNORMAL (agent-server itself died) → that
// case is the crash net's job (a future launch's startup sweep). Extracted from
// index.ts so it's unit-testable (index.ts runs on import). See the
// `detached-task-reaping` design.
import type { ServerBackend } from './providers/types';
import { reapDetachedTasks } from './reaper';

export interface PerformShutdownOpts {
  /** Live backends to reap + dispose. An array (re-iterated for reap then dispose). */
  backends: ServerBackend[];
  /** Upper bound on the reap so a hung provider RPC can't stall exit. */
  reapTimeoutMs: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Injected `process.exit` (kept injectable for tests). */
  exit: () => void;
}

export async function performShutdown(opts: PerformShutdownOpts): Promise<void> {
  const { backends, reapTimeoutMs, log, exit } = opts;
  try {
    const summary = await Promise.race([
      reapDetachedTasks(backends, (level, msg) => log(level, msg)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), reapTimeoutMs)),
    ]);
    if (summary) {
      log('info', `reaped ${summary.reaped}/${summary.enumerated} detached task(s) on shutdown`);
    } else {
      log('warn', `reap timed out after ${reapTimeoutMs}ms — disposing anyway`);
    }
  } catch (err: any) {
    log('error', `reap threw: ${err?.message ?? err}`);
  }
  for (const b of backends) {
    try {
      b.dispose();
    } catch {
      /* best-effort: one backend's dispose throwing must not block the others or exit */
    }
  }
  exit();
}
