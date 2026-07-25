import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { on, emit, emitAgent, Events } from '../events';
import { enqueuePendingSend } from '../agentTabStore';
import type { BranchMergedInfo, GitBranchInfo, WorktreeCloseKind } from '@shared/types';

// User-initiated finish/abandon popup for a worktree sub-project (#lifecycle).
// Opened from the sidebar right-click menu (Events.WORKTREE_CLOSE) — NOT the
// agent; the agent no longer drives the worktree lifecycle. The popup owns the
// whole close sequence and, on failure, offers a one-click "Send to agent" that
// hands the error to the worktree's own agent tab to resolve.
//
//   finish  = pick target ▾ (default baseBranch) → lock+ff merge-back → teardown
//             → delete branch (force; commits are safe on target after the ff)
//   abandon = teardown → delete branch (no merge; UNMERGED → commit loss)
//
// Success = the worktree sub-project disappears (REMOVE_PROJECT after teardown).

interface CloseState {
  subProjectId: string;
  kind: WorktreeCloseKind;
}

export function WorktreeCloseGate() {
  const { projects } = useStore();
  const [state, setState] = useState<CloseState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // finish only: local branches offered as ff targets + the chosen one.
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [target, setTarget] = useState('');
  // Delete the feature branch as part of the close (default on).
  const [deleteBranch, setDeleteBranch] = useState(true);
  // abandon only: is the branch already merged into base (→ safe delete) or would
  // a force-delete discard commits (→ loud warning). null until the check returns.
  const [mergeInfo, setMergeInfo] = useState<BranchMergedInfo | null>(null);

  const sub = state ? projects.find((p) => p.config.id === state.subProjectId) : undefined;
  const parent = sub ? projects.find((p) => p.config.id === sub.config.parentProjectId) : undefined;

  useEffect(() => {
    const off = on(Events.WORKTREE_CLOSE, (index: number, kind: WorktreeCloseKind) => {
      const proj = projects[index];
      if (!proj || !proj.config.parentProjectId) return; // guard: children only
      setState({ subProjectId: proj.config.id, kind });
      setBusy(false);
      setError(null);
      setDeleteBranch(true);
      setBranches([]);
      setMergeInfo(null);
      const base = proj.config.baseBranch ?? '';
      setTarget(base);

      const par = projects.find((p) => p.config.id === proj.config.parentProjectId);
      // finish: load the parent's local branches for the target selector (the
      // user's latch on WHERE the ff lands; default = captured fork point).
      if (kind === 'finish' && par) {
        window.shelfApi.git
          .branchList(par.config.connection, par.config.cwd)
          .then((found) => {
            setBranches(found.filter((b) => b.name !== proj.config.worktreeBranch));
            if (base && !found.some((b) => b.name === base) && found.length > 0) {
              setTarget(found[0].name);
            }
          })
          .catch(() => { /* selector just falls back to the text default */ });
      }
      // abandon: is the branch already merged into base → drives the adaptive
      // warning + whether the delete is safe (-d) or a forced discard (-D).
      if (kind === 'abandon' && par && base && proj.config.worktreeBranch) {
        window.shelfApi.git
          .branchMerged(par.config.connection, par.config.cwd, base, proj.config.worktreeBranch)
          .then(setMergeInfo)
          .catch(() => { /* stays null → cautious unmerged-style warning */ });
      }
    });
    return () => { off(); };
  }, [projects]);

  if (!state || !sub) return null;

  const isAbandon = state.kind === 'abandon';
  const branch = sub.config.worktreeBranch;
  // The worktree's agent tab, if any — the Send-to-agent target on failure.
  const agentTabId = sub.tabs.find((t) => t.type === 'agent')?.id;

  const close = () => {
    setState(null);
    setBusy(false);
    setError(null);
  };

  const sendToAgent = () => {
    if (!agentTabId || !error) return;
    const verb = isAbandon ? 'abandon' : 'finish';
    const text = `The worktree ${verb} failed with this error:\n\n${error}\n\nPlease resolve it here in this worktree, then I'll try again.`;
    const clientMsgId = crypto.randomUUID();
    enqueuePendingSend(agentTabId, clientMsgId, text);
    emitAgent('agent:send', { tabId: agentTabId, text, clientMsgId });
    close();
  };

  const approve = async () => {
    if (busy) return;
    if (!parent) {
      setError('worktree parent project not found');
      return;
    }
    setBusy(true);
    setError(null);

    const parentConn = parent.config.connection;
    const parentCwd = parent.config.cwd;
    const featureCwd = sub.config.cwd;
    const featureBranch = sub.config.worktreeBranch ?? '';

    // finish: fast-forward the target first; only a successful merge tears down.
    if (!isAbandon) {
      const mb = await window.shelfApi.worktree.finishMergeBack({
        connection: parentConn,
        featureCwd,
        baseCwd: parentCwd,
        baseBranch: target,
        featureBranch,
      });
      if (mb.outcome !== 'merged') {
        // busy / non-ff / base-dirty / error → show it; DON'T tear down. The user
        // can Send-to-agent (all errors, uniformly) or fix + retry.
        setError(mb.error ?? `merge-back failed (${mb.outcome})`);
        setBusy(false);
        return;
      }
    }

    // Teardown: remove the worktree dir, then delete the (now unchecked-out) branch.
    const rm = await window.shelfApi.git.worktreeRemove(parentConn, parentCwd, featureCwd);
    if (!rm.ok) {
      setError(rm.error ?? 'failed to remove worktree');
      setBusy(false);
      return;
    }
    if (featureBranch && deleteBranch) {
      // finish → force is safe (commits live on target after the ff). abandon →
      // force ONLY when the branch is unmerged (an intentional discard); a merged
      // branch uses a safe -d so a wrong "merged" verdict fails loud, not silently.
      const force = isAbandon ? !(mergeInfo?.merged ?? false) : true;
      const del = await window.shelfApi.git.deleteBranch(parentConn, parentCwd, featureBranch, force);
      if (!del.ok) {
        // Worktree already gone; a leftover branch is a loud anomaly, not data loss.
        setError(del.error ?? 'worktree removed but branch delete failed');
        setBusy(false);
        return;
      }
    }

    const subIndex = projects.findIndex((p) => p.config.id === state.subProjectId);
    close();
    if (subIndex >= 0) emit(Events.REMOVE_PROJECT, subIndex);
  };

  const title = isAbandon ? 'Abandon Worktree' : 'Finish Worktree';

  return (
    <div className="settings-overlay" onClick={busy ? undefined : close}>
      <div className="worktree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>{title}</span>
          <button className="settings-close" onClick={close} disabled={busy}>×</button>
        </div>
        <div className="worktree-gate-body">
          {isAbandon ? (
            <p>
              Abandon worktree {branch ? <strong>{branch}</strong> : 'this worktree'} without merging?
              {deleteBranch && mergeInfo?.merged && (
                <> The branch is <strong>already merged</strong> into {target || 'the base branch'} — deleting it is safe.</>
              )}
              {deleteBranch && mergeInfo && !mergeInfo.merged && (
                <> This <strong>permanently discards</strong> {mergeInfo.aheadCount} unmerged commit{mergeInfo.aheadCount === 1 ? '' : 's'}.</>
              )}
              {deleteBranch && !mergeInfo && (
                <> This <strong>permanently discards</strong> any unmerged commits.</>
              )}
            </p>
          ) : (
            <>
              <p>Merge {branch ? <strong>{branch}</strong> : 'this worktree'} back into:</p>
              {branches.length > 0 ? (
                <select
                  className="worktree-select"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={busy}
                >
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>{b.name}</option>
                  ))}
                </select>
              ) : (
                <p><strong>{target || 'the base branch'}</strong></p>
              )}
            </>
          )}
          <label className="worktree-checkbox">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
              disabled={busy}
            />
            <span>Delete branch {branch ? <strong>{branch}</strong> : ''}</span>
          </label>
          {error && (
            <div className="worktree-error">
              {error}
              <div className="worktree-error-actions">
                <button
                  className="conn-btn conn-btn-next"
                  onClick={sendToAgent}
                  disabled={!agentTabId}
                  title={agentTabId ? 'Send this error to the worktree agent' : 'No agent tab open in this worktree'}
                >
                  Send to agent
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={close} disabled={busy}>Cancel</button>
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
