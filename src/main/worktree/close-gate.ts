import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { getMainWindow } from '../app-state';
import { log } from '@shared/logger';
import type { WorktreeCloseKind, WorktreeCloseRequest, WorktreeCloseResolution } from '@shared/types';

/**
 * "main needs the user to approve closing a worktree sub-project" channel, for
 * the `worktree_project_finish` / `worktree_project_abandon` app-tool ops. Sibling
 * of create-gate.ts: an agent-driven close is gated by a client-owned confirm
 * popup (the dumb final execution gate; the smart "here's what you'll lose"
 * explanation is the agent's job, in chat).
 *
 * The RENDERER performs the client-owned close sequence on approve — finish:
 * lock+ff merge-back → teardown → delete branch; abandon: teardown → delete
 * branch — and reports the outcome back here. Cancel/busy/non-ff/base-dirty are
 * calm outcomes; only a genuine failure is an error. Fails closed to 'cancelled'
 * on timeout so a never-answered popup can't wedge the agent turn.
 */

const TIMEOUT_MS = 5 * 60_000;

export type WorktreeCloseOutcome = WorktreeCloseResolution['outcome'];

export interface WorktreeCloseResult {
  outcome: WorktreeCloseOutcome;
  error?: string;
}

interface Pending {
  settle: (o: WorktreeCloseResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

let seq = 0;
const pending = new Map<string, Pending>();

/** Ask the renderer to confirm + perform an agent-driven worktree close. */
export function requestWorktreeClose(meta: {
  kind: WorktreeCloseKind;
  subProjectId: string;
  /** finish only — agent-supplied ff merge-back target (#target); undefined → baseBranch. */
  target?: string;
}): Promise<WorktreeCloseResult> {
  seq += 1;
  const requestId = `wx-${seq}`;

  return new Promise<WorktreeCloseResult>((resolve) => {
    const timer = setTimeout(() => {
      log.error('worktree-close', `request ${requestId} (${meta.kind}) timed out → cancelled`);
      finish(requestId, { outcome: 'cancelled', error: 'confirm popup timed out' });
    }, TIMEOUT_MS);
    timer.unref?.();

    pending.set(requestId, { settle: resolve, timer });

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      const req: WorktreeCloseRequest = { requestId, ...meta };
      win.webContents.send(IPC.WORKTREE_CLOSE_REQUEST, req);
    } else {
      finish(requestId, { outcome: 'cancelled', error: 'no window to confirm' });
    }
  });
}

function finish(requestId: string, result: WorktreeCloseResult): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  clearTimeout(p.timer);

  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.WORKTREE_CLOSE_CLOSE, { requestId });

  p.settle(result);
}

export function registerWorktreeCloseHandlers(): void {
  ipcMain.handle(IPC.WORKTREE_CLOSE_RESOLVE, (_e, payload: unknown) => {
    const res = (payload ?? {}) as Partial<WorktreeCloseResolution>;
    if (!res.requestId) return;
    const known: WorktreeCloseOutcome[] = ['closed', 'cancelled', 'busy', 'non-ff', 'base-dirty', 'error'];
    const outcome = known.includes(res.outcome as WorktreeCloseOutcome)
      ? (res.outcome as WorktreeCloseOutcome) : 'cancelled';
    finish(res.requestId, { outcome, error: res.error });
  });
}
