import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { emit, Events } from '../events';
import { buildWorktreeChildConfig } from '../worktree-child-config';
import type { WorktreeCreateRequest } from '@shared/types';

// App-global confirm popup for the agent-driven `worktree_project_create` tool.
// Sibling of BrowserOpenPrompt: a main-side gate (worktree/create-gate.ts) sends
// a request; this shows a confirm popup and, on approve, performs the client-owned
// create sequence (worktreeAdd → migrate note → add sub-project) and reports the
// outcome back. Cancel is a normal outcome, surfaced calmly to the agent.
//
// This is the confirm-mode counterpart to WorktreeDialog (manual free-text entry):
// here the branch is agent-supplied and pre-shown, so the popup only approves.

export function WorktreeCreateGate() {
  const { projects } = useStore();
  const [queue, setQueue] = useState<WorktreeCreateRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);

  useEffect(() => {
    const offReq = window.shelfApi.worktree.onCreateRequest((req) => {
      setQueue((q) => [...q, req]);
    });
    // Resolved elsewhere (timed out) → drop it locally.
    const offClose = window.shelfApi.worktree.onCreateClose((requestId) => {
      setQueue((q) => q.filter((r) => r.requestId !== requestId));
    });
    return () => { offReq(); offClose(); };
  }, []);

  const current = queue[0];
  const parent = current ? projects.find((p) => p.config.id === current.parentProjectId) : undefined;

  // Fetch the parent's current branch to show the fork point ("from <baseBranch>")
  // — the branch this worktree is cut from AND the branch finish merges back into.
  // Best-effort/display only: the authoritative baseBranch is captured by
  // worktreeAdd on approve. Cleared + refetched whenever the front request changes.
  useEffect(() => {
    setBaseBranch(null);
    if (!current || !parent) return;
    let cancelled = false;
    window.shelfApi.git
      .branchList(parent.config.connection, parent.config.cwd)
      .then((branches) => {
        if (!cancelled) setBaseBranch(branches.find((b) => b.current)?.name ?? null);
      })
      .catch(() => { /* display-only; leave it out if git can't answer */ });
    return () => { cancelled = true; };
  }, [current?.requestId, parent?.config.id]);

  if (!current) return null;

  const dequeue = () => {
    setQueue((q) => q.slice(1));
    setBusy(false);
    setError(null);
  };

  const cancel = () => {
    window.shelfApi.worktree.resolveCreate({ requestId: current.requestId, outcome: 'cancelled' });
    dequeue();
  };

  const approve = async () => {
    if (busy) return;
    if (!parent) {
      // Parent vanished between request and approval — fail-loud to the agent.
      window.shelfApi.worktree.resolveCreate({
        requestId: current.requestId,
        outcome: 'error',
        error: 'parent project not found',
      });
      dequeue();
      return;
    }
    setBusy(true);
    setError(null);
    const { connection, cwd } = parent.config;

    // 1. Create the worktree (also captures the parent's baseBranch atomically).
    const add = await window.shelfApi.git.worktreeAdd(connection, cwd, current.branch, true);
    if (!add.ok || !add.path) {
      const msg = add.error ?? 'failed to create worktree';
      setError(msg);
      window.shelfApi.worktree.resolveCreate({ requestId: current.requestId, outcome: 'error', error: msg });
      dequeue();
      return;
    }

    // 2. Migrate the Phase-0 note BEFORE the sub-project (and its agent) exists, so
    //    the fresh agent boots with the note already in place. Fail-loud + roll back
    //    the just-created worktree rather than booting a broken one.
    if (current.notePath) {
      const mig = await window.shelfApi.git.migrateNote(connection, cwd, add.path, current.notePath);
      if (!mig.ok) {
        await window.shelfApi.git.worktreeRemove(connection, cwd, add.path);
        const msg = mig.error ?? 'failed to migrate feature note';
        setError(msg);
        window.shelfApi.worktree.resolveCreate({ requestId: current.requestId, outcome: 'error', error: msg });
        dequeue();
        return;
      }
    }

    // 3. Copy the parent's secrets under the new id BEFORE the sub-project (and its
    //    processes) exist, so the worktree's first agent/terminal sees them. Encrypted
    //    blobs reused under one master key; pruned automatically on close.
    const projectId = `wt-${Date.now()}`;
    await window.shelfApi.project.copySecrets(parent.config.id, projectId);

    // 4. Add the sub-project (inherits the parent's setup; base is freed; focus jumps).
    const childConfig = buildWorktreeChildConfig(parent.config, {
      id: projectId,
      cwd: add.path,
      worktreeBranch: current.branch,
      baseBranch: add.baseBranch,
    });
    emit(Events.ADD_PROJECT, childConfig);

    window.shelfApi.worktree.resolveCreate({
      requestId: current.requestId,
      outcome: 'created',
      projectId,
      baseBranch: add.baseBranch,
    });
    // 5. Auto-connect the fresh worktree so its agent boots and reads the note (the
    //    flow's whole point). Deterministic post-store connect lives in App (keyed on
    //    the store), avoiding the bus handlers' stale-projects closure.
    emit(Events.AUTO_CONNECT_PROJECT, projectId);
    dequeue();
  };

  return (
    <div className="settings-overlay" onClick={busy ? undefined : cancel}>
      <div className="worktree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Create Worktree</span>
          <button className="settings-close" onClick={cancel} disabled={busy}>×</button>
        </div>
        <div className="worktree-gate-body">
          <p>
            Cut a new worktree on branch <strong>{current.branch}</strong>
            {baseBranch ? <> from <strong>{baseBranch}</strong></> : null}
            {parent ? <> in <strong>{parent.config.name}</strong></> : null}?
          </p>
          {current.notePath && (
            <p className="worktree-gate-note">Feature note <code>{current.notePath}</code> will move into the worktree.</p>
          )}
          {error && <div className="worktree-error">{error}</div>}
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={cancel} disabled={busy}>Cancel</button>
          <button className="conn-btn conn-btn-next" onClick={approve} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
