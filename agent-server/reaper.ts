// Centralized detached-task reaper. Runs ONCE over all live backends on any
// NORMAL agent-server closure (see shutdown.ts — no main signal), enumerating each
// provider's escaped-tree background tasks and killing the still-running ones
// through the uniform `stopTask` contract. Kept out of each provider's `dispose()`
// so the enumerate→kill policy lives in one place and `dispose()` stays a plain
// resource-close. See the `detached-task-reaping` design.
import type { ServerBackend } from './providers/types';

export interface ReapSummary {
  /** Total reapable tasks enumerated across all backends. */
  enumerated: number;
  /** How many running tasks we asked `stopTask` to reap. */
  reaped: number;
}

/**
 * Reap running detached tasks across `backends`. Best-effort + fail-loud:
 * a throwing `listReapableTasks`/`stopTask` on ONE backend is logged and does
 * NOT block the others (nor the caller's exit). Backends that don't implement
 * both contract methods are skipped. Terminal tasks (`status:'done'`) are left
 * alone. Does NOT bound its own time — the caller wraps it in a timeout so a
 * hung provider RPC can't stall shutdown.
 */
export async function reapDetachedTasks(
  backends: Iterable<ServerBackend>,
  log: (level: 'warn' | 'error', msg: string) => void,
): Promise<ReapSummary> {
  let enumerated = 0;
  let reaped = 0;
  for (const b of backends) {
    if (!b.listReapableTasks || !b.stopTask) continue;
    let tasks;
    try {
      tasks = await b.listReapableTasks();
    } catch (err: any) {
      log('error', `reaper: listReapableTasks failed: ${err?.message ?? err}`);
      continue;
    }
    for (const t of tasks) {
      enumerated++;
      if (t.status !== 'running') continue;
      try {
        await b.stopTask(t.id);
        reaped++;
      } catch (err: any) {
        log('error', `reaper: stopTask(${t.id}) failed: ${err?.message ?? err}`);
      }
    }
  }
  return { enumerated, reaped };
}
