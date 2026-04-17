import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { on, emit, Events } from '../events';

export function WorktreeDialog() {
  const { projects } = useStore();
  const [open, setOpen] = useState(false);
  const [projectIndex, setProjectIndex] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const off = on(Events.CREATE_WORKTREE, (index: number) => {
      setProjectIndex(index);
      setOpen(true);
      setInput('');
      setError(null);
      setCreating(false);
    });
    return () => { off(); };
  }, [projects]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleCreate = useCallback(async () => {
    const branch = input.trim();
    if (!branch || projectIndex === null || creating) return;

    const proj = projects[projectIndex];
    if (!proj) return;

    setCreating(true);
    setError(null);

    const result = await window.shelfApi.git.worktreeAdd(
      proj.config.connection,
      proj.config.cwd,
      branch,
      true,
    );

    if (!result.ok) {
      setError(result.error ?? 'Failed to create worktree');
      setCreating(false);
      return;
    }

    emit(Events.ADD_PROJECT, {
      id: `wt-${Date.now()}`,
      name: proj.config.name,
      cwd: result.path!,
      connection: proj.config.connection,
      maxTabs: proj.config.maxTabs,
      initScript: proj.config.initScript,
      parentProjectId: proj.config.id,
      worktreeBranch: branch,
    });

    setOpen(false);
  }, [input, projectIndex, projects, creating]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    }
  };

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={() => setOpen(false)}>
      <div className="worktree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>New Worktree</span>
          <button className="settings-close" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="worktree-dialog-body">
          <input
            ref={inputRef}
            className="worktree-input"
            type="text"
            placeholder="New branch name"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(null); }}
            onKeyDown={handleKeyDown}
            disabled={creating}
          />
          {error && <div className="worktree-error">{error}</div>}
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={() => setOpen(false)}>Cancel</button>
          <button
            className="conn-btn conn-btn-next"
            disabled={!input.trim() || creating}
            onClick={handleCreate}
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
