import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { on, emit, Events } from '../events';

interface PendingRemove {
  projectId: string;
  isWorktree: boolean;
  projectName: string;
  branch?: string | null;
}

export const CONFIRM_REMOVE_EVENT = 'confirm-remove-project';

export function RemoveConfirmDialog() {
  const { projects } = useStore();
  const [pending, setPending] = useState<PendingRemove | null>(null);
  const [cleanWorktree, setCleanWorktree] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = on(CONFIRM_REMOVE_EVENT, (projectId: string) => {
      const proj = projects.find((p) => p.id === projectId);
      if (!proj) return;
      setPending({
        projectId,
        isWorktree: !!proj.parentProjectId,
        projectName: proj.name,
        branch: proj.worktreeBranch,
      });
      setCleanWorktree(true);
    });
    return () => { off(); };
  }, [projects]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending]);

  if (!pending) return null;

  const handleConfirm = async () => {
    const proj = projects.find((p) => p.id === pending.projectId);
    if (pending.isWorktree && cleanWorktree && proj) {
      const parent = projects.find((p) => p.id === proj.parentProjectId);
      if (parent) {
        await window.shelfApi.git.worktreeRemove(
          parent.connection,
          parent.cwd,
          proj.cwd,
        );
      }
    }
    emit(Events.REMOVE_PROJECT, pending.projectId);
    setPending(null);
  };

  const displayName = pending.branch
    ? `${pending.projectName} (${pending.branch})`
    : pending.projectName;

  return (
    <div className="settings-overlay" onClick={() => setPending(null)}>
      <div className="worktree-dialog" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Remove Project</span>
          <button className="settings-close" onClick={() => setPending(null)}>×</button>
        </div>
        <div className="remove-confirm-body">
          <p>Remove <strong>{displayName}</strong>?</p>
          {pending.isWorktree && (
            <label className="remove-confirm-checkbox">
              <input
                type="checkbox"
                checked={cleanWorktree}
                onChange={(e) => setCleanWorktree(e.target.checked)}
              />
              Also delete worktree files
            </label>
          )}
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={() => setPending(null)}>Cancel</button>
          <button className="conn-btn conn-btn-danger" onClick={handleConfirm}>Remove</button>
        </div>
      </div>
    </div>
  );
}
