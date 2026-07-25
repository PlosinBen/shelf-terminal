import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { getMainWindow } from '../app-state';
import { log } from '@shared/logger';
import type { WorktreeCreateRequest, WorktreeCreateResolution } from '@shared/types';

/**
 * "main needs the user to approve cutting a worktree sub-project" channel, for
 * the `worktree_project_create` app-tool op. Sibling of browser-open.ts: an
 * agent-driven create is gated by a client-owned confirm popup before anything
 * is created.
 *
 * The RENDERER is the true execution subject — on approve it runs the client-owned
 * create sequence (worktreeAdd → migrate note → add sub-project) and reports the
 * outcome back here. So this module only relays the request and awaits the
 * resolution; it performs no git/project work itself.
 *
 * Cancel is a NORMAL outcome (the user said "not here"), surfaced to the agent as
 * a calm result — not an error. A never-answered popup fails closed to 'cancelled'
 * after a timeout so it can't wedge the agent turn forever.
 */

// Generous — a real user may deliberate. Only a floor against "nobody answers".
const TIMEOUT_MS = 5 * 60_000;

export interface WorktreeCreateOutcome {
  outcome: 'created' | 'cancelled' | 'error';
  projectId?: string;
  baseBranch?: string;
  error?: string;
}

interface Pending {
  settle: (o: WorktreeCreateOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

let seq = 0;
const pending = new Map<string, Pending>();

/** Ask the renderer to confirm + perform an agent-driven worktree create. */
export function requestWorktreeCreate(
  meta: Omit<WorktreeCreateRequest, 'requestId'>,
): Promise<WorktreeCreateOutcome> {
  seq += 1;
  const requestId = `wc-${seq}`;

  return new Promise<WorktreeCreateOutcome>((resolve) => {
    const timer = setTimeout(() => {
      log.error('worktree-create', `request ${requestId} for ${meta.branch} timed out → cancelled`);
      finish(requestId, { outcome: 'cancelled', error: 'confirm popup timed out' });
    }, TIMEOUT_MS);
    timer.unref?.();

    pending.set(requestId, { settle: resolve, timer });

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      const req: WorktreeCreateRequest = { requestId, ...meta };
      win.webContents.send(IPC.WORKTREE_CREATE_REQUEST, req);
    } else {
      // No window to ask → nobody can answer → fail-closed to cancelled.
      finish(requestId, { outcome: 'cancelled', error: 'no window to confirm' });
    }
  });
}

function finish(requestId: string, outcome: WorktreeCreateOutcome): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  clearTimeout(p.timer);

  // Dismiss the popup if it's still up (e.g. resolved by timeout).
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.WORKTREE_CREATE_CLOSE, { requestId });

  p.settle(outcome);
}

export function registerWorktreeCreateHandlers(): void {
  ipcMain.handle(IPC.WORKTREE_CREATE_RESOLVE, (_e, payload: unknown) => {
    const res = (payload ?? {}) as Partial<WorktreeCreateResolution>;
    if (!res.requestId) return;
    const outcome = res.outcome === 'created' || res.outcome === 'error' ? res.outcome : 'cancelled';
    finish(res.requestId, {
      outcome,
      projectId: res.projectId,
      baseBranch: res.baseBranch,
      error: res.error,
    });
  });
}
