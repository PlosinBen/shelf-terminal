import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { emit, Events } from '../events';
import type { WorktreeCloseRequest, WorktreeCloseResolution } from '@shared/types';

// App-global confirm popup for the agent-driven worktree_project_finish /
// worktree_project_abandon tools. Sibling of WorktreeCreateGate: a main-side gate
// (worktree/close-gate.ts) sends a request; on approve this runs the client-owned
// close sequence and reports the outcome back.
//
//   finish  = lock+ff merge-back → (merged) teardown → delete branch (force; safe,
//             commits live on baseBranch after the ff)
//   abandon = teardown → delete branch (force; UNMERGED → permanent commit loss)
//
// The popup is the dumb final execution gate; the "what you'll lose" explanation
// is the agent's job in chat. Success = the worktree sub-project disappears — we
// resolve the outcome to the agent BEFORE REMOVE_PROJECT tears down the calling
// tab, so the op result isn't lost when the tab (the caller) is killed.

export function WorktreeCloseGate() {
  const { projects } = useStore();
  const [queue, setQueue] = useState<WorktreeCloseRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const offReq = window.shelfApi.worktree.onCloseRequest((req) => {
      setQueue((q) => [...q, req]);
    });
    const offClose = window.shelfApi.worktree.onCloseClose((requestId) => {
      setQueue((q) => q.filter((r) => r.requestId !== requestId));
    });
    return () => { offReq(); offClose(); };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const subIndex = projects.findIndex((p) => p.config.id === current.subProjectId);
  const sub = subIndex >= 0 ? projects[subIndex] : undefined;
  const parent = sub ? projects.find((p) => p.config.id === sub.config.parentProjectId) : undefined;
  const isAbandon = current.kind === 'abandon';
  // The ff merge-back target: agent-supplied (#target) or the captured baseBranch
  // (fork point). Shown in the popup so the user can veto a wrong-but-ff-able target.
  const mergeTarget = current.target?.trim() || (sub?.config.baseBranch ?? '');

  const dequeue = () => {
    setQueue((q) => q.slice(1));
    setBusy(false);
    setError(null);
  };

  const resolve = (resolution: Omit<WorktreeCloseResolution, 'requestId'>) => {
    window.shelfApi.worktree.resolveClose({ requestId: current.requestId, ...resolution });
  };

  const cancel = () => {
    resolve({ outcome: 'cancelled' });
    dequeue();
  };

  const approve = async () => {
    if (busy) return;
    if (!sub || !parent) {
      resolve({ outcome: 'error', error: 'worktree sub-project or its parent not found' });
      dequeue();
      return;
    }
    setBusy(true);
    setError(null);

    const parentConn = parent.config.connection;
    const parentCwd = parent.config.cwd;
    const featureCwd = sub.config.cwd;
    const featureBranch = sub.config.worktreeBranch ?? '';

    // finish: fast-forward baseBranch first; only a successful merge proceeds to teardown.
    if (!isAbandon) {
      const mb = await window.shelfApi.worktree.finishMergeBack({
        connection: parentConn,
        featureCwd,
        baseCwd: parentCwd,
        baseBranch: mergeTarget,
        featureBranch,
      });
      if (mb.outcome !== 'merged') {
        // busy / non-ff / base-dirty / error → report, DON'T tear down.
        if (mb.outcome === 'error') setError(mb.error ?? 'merge-back failed');
        resolve({ outcome: mb.outcome, error: mb.error });
        dequeue();
        return;
      }
    }

    // Teardown: remove the worktree dir, then delete the (now unchecked-out) branch.
    const rm = await window.shelfApi.git.worktreeRemove(parentConn, parentCwd, featureCwd);
    if (!rm.ok) {
      setError(rm.error ?? 'failed to remove worktree');
      resolve({ outcome: 'error', error: rm.error });
      dequeue();
      return;
    }
    if (featureBranch) {
      // force: finish → commits are safe on baseBranch; abandon → intentional loss.
      const del = await window.shelfApi.git.deleteBranch(parentConn, parentCwd, featureBranch, true);
      if (!del.ok) {
        // The worktree is already gone; a leftover branch is a loud anomaly but not
        // a data-loss event — surface it rather than swallow.
        resolve({ outcome: 'error', error: del.error ?? 'failed to delete branch' });
        dequeue();
        return;
      }
    }

    // Resolve BEFORE REMOVE_PROJECT: removing the sub-project tears down its agent
    // tab (the caller), so the op result must already be on its way to the agent.
    resolve({ outcome: 'closed' });
    emit(Events.REMOVE_PROJECT, subIndex);
    dequeue();
  };

  const title = isAbandon ? 'Abandon Worktree' : 'Finish Worktree';
  const branch = sub?.config.worktreeBranch;

  return (
    <div className="settings-overlay" onClick={busy ? undefined : cancel}>
      <div className="worktree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>{title}</span>
          <button className="settings-close" onClick={cancel} disabled={busy}>×</button>
        </div>
        <div className="worktree-gate-body">
          {isAbandon ? (
            <p>
              Abandon worktree {branch ? <strong>{branch}</strong> : null} and delete its branch?
              This <strong>permanently discards</strong> any unmerged commits.
            </p>
          ) : (
            <p>
              Merge {branch ? <strong>{branch}</strong> : 'this worktree'} back into{' '}
              <strong>{mergeTarget || 'the base branch'}</strong> and close it?
            </p>
          )}
          {error && <div className="worktree-error">{error}</div>}
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={cancel} disabled={busy}>Cancel</button>
          <button
            className={`conn-btn ${isAbandon ? 'conn-btn-danger' : 'conn-btn-next'}`}
            onClick={approve}
            disabled={busy}
          >
            {busy ? 'Working…' : isAbandon ? 'Abandon' : 'Finish'}
          </button>
        </div>
      </div>
    </div>
  );
}
