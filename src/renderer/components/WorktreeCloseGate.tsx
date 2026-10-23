import { isWorktreeUnavailable } from '@shared/worktree';
import { useEffect, useState } from 'react';
import { projectDisplayLabel, useStore } from '../store';
import { on, emit, emitAgent, Events } from '../events';
import { enqueuePendingSend } from '../agentTabStore';
import { debugLog } from '../debugLog';
import type { BranchMergedInfo, GitBranchInfo, WorktreeCloseKind } from '@shared/types';

// User-committed finish/abandon popup for a worktree sub-project (#lifecycle).
// Opened from the sidebar menu or an agent's side-effect-free proposal
// (Events.WORKTREE_CLOSE); the human always commits the lifecycle action here.
// The popup owns the whole close sequence and, on failure, offers a one-click
// "Send to agent" that hands the error to the worktree's own agent tab.
//
//   finish  = pick target ▾ (default baseBranch) → note preflight for full Finish
//             → lock+ff merge-back → optional teardown
//               → delete branch (force; commits are safe on target after the ff)
//   abandon = restore carried feature notes → teardown
//             → delete branch (no merge; UNMERGED → commit loss)
//
// Merge-only preserves the environment; completion reports whether teardown ran.

interface CloseState {
  subProjectId: string;
  kind: WorktreeCloseKind;
}

function logCloseFailure(input: {
  operation: WorktreeCloseKind;
  subProjectId: string;
  parentProjectId?: string | null;
  featureBranch?: string | null;
  targetBranch?: string;
  parentCwd?: string;
  featureCwd?: string;
  failedStep: string;
  error: string;
}) {
  debugLog('worktree-close', JSON.stringify(input));
}

export function WorktreeCloseGate() {
  const { projects } = useStore();
  const [state, setState] = useState<CloseState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // finish only: local branches offered as ff targets + the chosen one.
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [target, setTarget] = useState('');
  // Finish defaults to full cleanup; Abandon independently controls branch deletion.
  const [onlyMerge, setOnlyMerge] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  // abandon only: is the branch already merged into base (→ safe delete) or would
  // a force-delete discard commits (→ loud warning). null until the check returns.
  const [mergeInfo, setMergeInfo] = useState<BranchMergedInfo | null>(null);

  const sub = state ? projects.find((p) => p.id === state.subProjectId) : undefined;
  const parent = sub ? projects.find((p) => p.id === sub.parentProjectId) : undefined;

  useEffect(() => {
    const off = on(Events.WORKTREE_CLOSE, (projectId: string, kind: WorktreeCloseKind) => {
      const proj = projects.find((p) => p.id === projectId);
      if (!proj || isWorktreeUnavailable(proj) || !proj.parentProjectId) return; // guard: children only
      setState({ subProjectId: proj.id, kind });
      setBusy(false);
      setError(null);
      setDeleteBranch(true);
      setOnlyMerge(false);
      setBranches([]);
      setMergeInfo(null);
      const base = proj.baseBranch ?? '';
      setTarget(base);

      const par = projects.find((p) => p.id === proj.parentProjectId);
      // finish: load the parent's local branches for the target selector (the
      // user's latch on WHERE the ff lands; default = captured fork point).
      if (kind === 'finish' && par) {
        window.shelfApi.git
          .branchList(par.connection, par.cwd)
          .then((found) => {
            setBranches(found.filter((b) => b.name !== proj.worktreeBranch));
            if ((!base || !found.some((b) => b.name === base)) && found.length > 0) {
              setTarget(found[0].name);
            }
          })
          .catch(() => { /* selector just falls back to the text default */ });
      }
      // abandon: is the branch already merged into base → drives the adaptive
      // warning + whether the delete is safe (-d) or a forced discard (-D).
      if (kind === 'abandon' && par && base && proj.worktreeBranch) {
        window.shelfApi.git
          .branchMerged(par.connection, par.cwd, base, proj.worktreeBranch)
          .then(setMergeInfo)
          .catch(() => { /* stays null → cautious unmerged-style warning */ });
      }
    });
    return () => { off(); };
  }, [projects]);

  if (!state || !sub) return null;

  const isAbandon = state.kind === 'abandon';
  const branch = sub.worktreeBranch;
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
    if (busy || isWorktreeUnavailable(sub)) return;
    if (!parent) {
      const msg = 'worktree parent project not found';
      logCloseFailure({
        operation: state.kind,
        subProjectId: state.subProjectId,
        parentProjectId: sub.parentProjectId,
        featureBranch: branch,
        featureCwd: sub.cwd,
        failedStep: 'missingParentProject',
        error: msg,
      });
      setError(msg);
      return;
    }
    setBusy(true);
    setError(null);

    let lifecycleStarted = false;
    try {
      await window.shelfApi.worktree.lifecycle(parent.id, true);
      lifecycleStarted = true;
    const parentConn = parent.connection;
    const parentCwd = parent.cwd;
    const featureCwd = sub.cwd;
    const source = await window.shelfApi.worktree.source(sub.id);
    const featureBranch = source.branch ?? '';
    const sourceLabel = source.branch ?? projectDisplayLabel({ ...sub, worktreeBranch: null });
    const notifyFinishCompleted = (worktreeRemoved: boolean) => {
      emit(Events.WORKTREE_FINISH_COMPLETED, {
        subProjectId: state.subProjectId,
        parentProjectId: parent.id,
        sourceLabel,
        targetBranch: target,
        worktreeRemoved,
      });
    };

    // worktree#16: one note preflight before any merge or cleanup; Only merge
    // retains the environment and does not inspect notes.
    if (!isAbandon && !onlyMerge && sub.featureNoteDir) {
      let problem: string | null = null;
      try {
        const listed = await window.shelfApi.git.listFeatureNotes(parentConn, featureCwd, sub.featureNoteDir);
        if (!listed.ok) {
          problem = `Unable to check feature notes in ${sub.featureNoteDir}: ${listed.error}`;
        } else if (listed.notes.length > 0) {
          problem = `Remaining feature notes in ${sub.featureNoteDir}:\n${listed.notes.map((note) => note.path).join('\n')}\nResolve these notes before finishing, or select Only merge to retain the worktree.`;
        }
      } catch (error) {
        problem = `Unable to check feature notes in ${sub.featureNoteDir}: ${String(error)}`;
      }
      if (problem) {
        const message = `Finish blocked. No merge or cleanup has been performed.\n${problem}`;
        logCloseFailure({
          operation: state.kind, subProjectId: sub.id, parentProjectId: parent.id,
          featureBranch, targetBranch: target, parentCwd, featureCwd,
          failedStep: 'featureNotes', error: message,
        });
        setError(message);
        return;
      }
    }

    // finish: fast-forward the target first; only a successful merge tears down.
    if (!isAbandon) {
      const mb = await window.shelfApi.worktree.finishMergeBack({
        connection: parentConn,
        featureCwd,
        baseCwd: parentCwd,
        baseBranch: target,
        featureBranch,
        sourceCommit: source.commit,
      });
      if (mb.outcome !== 'merged') {
        // busy / non-ff / feature-dirty / base-dirty / error → show it; DON'T
        // tear down. The user can Send-to-agent (all errors, uniformly) or fix + retry.
        const msg = mb.error ?? `merge-back failed (${mb.outcome})`;
        logCloseFailure({
          operation: state.kind,
          subProjectId: state.subProjectId,
          parentProjectId: parent.id,
          featureBranch,
          targetBranch: target,
          parentCwd,
          featureCwd,
          failedStep: 'mergeBack',
          error: msg,
        });
        setError(msg);
        setBusy(false);
        return;
      }
      if (onlyMerge) {
        // worktree#16: merge-only preserves notes, sessions, and current focus.
        close();
        notifyFinishCompleted(false);
        return;
      }
    }

    // Restore from the child's creation-time snapshot. Disabled/legacy children
    // have no binding and deliberately skip feature-note handling.
    if (isAbandon && sub.featureNoteDir) {
      const restored = await window.shelfApi.git.restoreNotes(
        parentConn,
        parentCwd,
        featureCwd,
        sub.featureNoteDir,
      );
      if (!restored.ok) {
        const msg = restored.error ?? 'failed to restore feature notes';
        logCloseFailure({
          operation: state.kind,
          subProjectId: state.subProjectId,
          parentProjectId: parent.id,
          featureBranch,
          targetBranch: target,
          parentCwd,
          featureCwd,
          failedStep: 'restoreNotes',
          error: msg,
        });
        setError(msg);
        setBusy(false);
        return;
      }
    }

    const currentSource = await window.shelfApi.worktree.source(sub.id);
    if (currentSource.commit !== source.commit || currentSource.branch !== source.branch ||
        currentSource.identity.gitDir !== source.identity.gitDir || currentSource.identity.commonDir !== source.identity.commonDir) {
      throw new Error('Worktree changed after merge; cleanup stopped. Rescan and retry.');
    }
    // Teardown: remove the worktree dir, then delete the (now unchecked-out) branch.
    const rm = await window.shelfApi.git.worktreeRemove(parentConn, parentCwd, featureCwd);
    if (!rm.ok) {
      const msg = rm.error ?? 'failed to remove worktree';
      logCloseFailure({
        operation: state.kind,
        subProjectId: state.subProjectId,
        parentProjectId: parent.id,
        featureBranch,
        targetBranch: target,
        parentCwd,
        featureCwd,
        failedStep: 'worktreeRemove',
        error: msg,
      });
      setError(msg);
      setBusy(false);
      return;
    }
    if (featureBranch && (!isAbandon || deleteBranch)) {
      // finish → force is safe (commits live on target after the ff). abandon →
      // force ONLY when the branch is unmerged (an intentional discard); a merged
      // branch uses a safe -d so a wrong "merged" verdict fails loud, not silently.
      const force = isAbandon ? !(mergeInfo?.merged ?? false) : true;
      const del = await window.shelfApi.git.deleteBranch(parentConn, parentCwd, featureBranch, force);
      if (!del.ok) {
        // Worktree already gone; a leftover branch is a loud anomaly, not data loss.
        const msg = del.error ?? 'worktree removed but branch delete failed';
        logCloseFailure({
          operation: state.kind,
          subProjectId: state.subProjectId,
          parentProjectId: parent.id,
          featureBranch,
          targetBranch: target,
          parentCwd,
          featureCwd,
          failedStep: 'deleteBranch',
          error: msg,
        });
        setError(msg);
        setBusy(false);
        return;
      }
    }

    close();
    if (projects.some((p) => p.id === state.subProjectId)) {
      if (isAbandon) {
        emit(Events.REMOVE_PROJECT, state.subProjectId);
      } else {
        notifyFinishCompleted(true);
      }
    }
    } catch (error) {
      const message = String(error);
      setError(message);
      logCloseFailure({ operation: state.kind, subProjectId: sub.id, parentProjectId: parent.id, failedStep: 'lifecycle', error: message });
    } finally {
      setBusy(false);
      if (lifecycleStarted) {
        try { await window.shelfApi.worktree.lifecycle(parent.id, false); }
        catch (error) { setError(String(error)); logCloseFailure({ operation: state.kind, subProjectId: sub.id, parentProjectId: parent.id, failedStep: 'releaseLifecycle', error: String(error) }); }
      }
    }

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
          <div className="project-requester">Requested by: {projectDisplayLabel(sub)}</div>
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
              {sub.featureNoteDir && (
                <> Any remaining feature notes will be restored to the parent project before the worktree is removed.</>
              )}
            </p>
          ) : (
            <>
              <p>Merge {branch ? <strong>{branch}</strong> : 'this worktree'} back into:</p>
              {branches.length > 0 ? (
                <select
                  className="worktree-select"
                  value={target}
                  onChange={(e) => { setTarget(e.target.value); setError(null); }}
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
              checked={isAbandon ? deleteBranch : onlyMerge}
              onChange={(e) => {
                if (isAbandon) setDeleteBranch(e.target.checked);
                else setOnlyMerge(e.target.checked);
                setError(null);
              }}
              disabled={busy}
            />
            <span>{isAbandon
              ? <>Delete branch {branch ? <strong>{branch}</strong> : ''}</>
              : 'Only merge'}</span>
          </label>
          {!isAbandon && (
            <p>{onlyMerge
              ? 'Keep the branch, worktree, project, and feature notes after merging.'
              : 'Merge and remove the worktree, project, and source branch. Remaining feature notes block Finish.'}</p>
          )}
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
