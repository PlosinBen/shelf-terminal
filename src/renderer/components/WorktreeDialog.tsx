import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { on, emit, Events } from '../events';
import type { GitBranchInfo } from '@shared/types';

export function WorktreeDialog() {
  const { projects } = useStore();
  const [open, setOpen] = useState(false);
  const [projectIndex, setProjectIndex] = useState<number | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = on(Events.CREATE_WORKTREE, (index: number) => {
      setProjectIndex(index);
      setOpen(true);
      setInput('');
      setError(null);
      setSelectedIndex(0);
      setCreating(false);

      const proj = projects[index];
      if (!proj) return;

      setLoading(true);
      window.shelfApi.git.branchList(proj.config.connection, proj.config.cwd).then((list) => {
        setBranches(list.filter((b) => !b.current));
        setLoading(false);
      });
    });
    return () => { off(); };
  }, [projects]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = branches.filter((b) =>
    b.name.toLowerCase().includes(input.toLowerCase()),
  );

  const isNewBranch = input.length > 0 && !branches.some((b) => b.name === input);

  const handleCreate = useCallback(async (branch: string, newBranch: boolean) => {
    if (projectIndex === null || creating) return;
    const proj = projects[projectIndex];
    if (!proj) return;

    setCreating(true);
    setError(null);

    const result = await window.shelfApi.git.worktreeAdd(
      proj.config.connection,
      proj.config.cwd,
      branch,
      newBranch,
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
  }, [projectIndex, projects, creating]);

  const handleSelect = useCallback(() => {
    if (isNewBranch) {
      handleCreate(input, true);
    } else if (filtered.length > 0) {
      handleCreate(filtered[selectedIndex].name, false);
    }
  }, [isNewBranch, input, filtered, selectedIndex, handleCreate]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect();
    }
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [input]);

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.children[selectedIndex] as HTMLElement;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

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
            placeholder="Branch name (type to filter or create new)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={creating}
          />
          {error && <div className="worktree-error">{error}</div>}
          {loading ? (
            <div className="worktree-loading">Loading branches...</div>
          ) : (
            <div className="worktree-branch-list" ref={listRef}>
              {isNewBranch && (
                <div
                  className={`worktree-branch-item new-branch ${filtered.length === 0 ? 'selected' : ''}`}
                  onClick={() => handleCreate(input, true)}
                >
                  Create new branch: <strong>{input}</strong>
                </div>
              )}
              {filtered.map((b, i) => (
                <div
                  key={b.name}
                  className={`worktree-branch-item ${i === selectedIndex ? 'selected' : ''}`}
                  onClick={() => handleCreate(b.name, false)}
                >
                  {b.name}
                </div>
              ))}
              {!isNewBranch && filtered.length === 0 && (
                <div className="worktree-empty">No branches found</div>
              )}
            </div>
          )}
        </div>
        {creating && <div className="worktree-creating">Creating worktree...</div>}
      </div>
    </div>
  );
}
