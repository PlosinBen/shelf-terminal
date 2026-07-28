import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { on, emit, Events } from '../events';
import { buildWorktreeChildConfig } from '../worktree-child-config';
import type { AgentProvider, FeatureNoteInfo } from '@shared/types';
import { agentProviderEntries } from '@shared/agent-providers';

// Sentinel <select> value for "don't seed a note" (a valid degenerate: the fresh
// agent starts with no Phase-0 context). '' can't collide with a note path.
const NO_NOTE = '';

export function WorktreeDialog() {
  const { projects } = useStore();
  const [open, setOpen] = useState(false);
  const [projectIndex, setProjectIndex] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // In-progress feature notes in the base repo, offered as the handoff seed. The
  // picked note is migrated into the worktree before its agent boots.
  const [notes, setNotes] = useState<FeatureNoteInfo[]>([]);
  const [selectedNote, setSelectedNote] = useState<string>(NO_NOTE);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [defaultAgentProvider, setDefaultAgentProvider] = useState<AgentProvider>('claude');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const off = on(Events.CREATE_WORKTREE, (index: number, prefill?: { branch?: string; notePath?: string }) => {
      setProjectIndex(index);
      setOpen(true);
      setInput(prefill?.branch ?? '');
      setError(null);
      setCreating(false);
      setNotes([]);
      setSelectedNote(prefill?.notePath ?? NO_NOTE);
      setBaseBranch(null);

      // Fetch the base repo's in-progress notes for the picker. Pre-select when
      // there's exactly one (the common case: one feature under discussion);
      // otherwise default to "no note" so the user chooses deliberately.
      const proj = projects[index];
      if (proj) {
        setDefaultAgentProvider(proj.config.defaultAgentProvider ?? 'claude');
        window.shelfApi.git.branchList(proj.config.connection, proj.config.cwd)
          .then((branches) => setBaseBranch(branches.find((branch) => branch.current)?.name ?? null))
          .catch(() => setBaseBranch(null));
        window.shelfApi.git
          .listFeatureNotes(proj.config.connection, proj.config.cwd)
          .then((found) => {
            setNotes(found);
            if (!prefill?.notePath && found.length === 1) setSelectedNote(found[0].path);
          })
          .catch(() => { /* picker just shows no notes; create still works */ });
      }
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
    const { connection, cwd } = proj.config;

    // 1. Create the worktree (captures the parent's baseBranch atomically).
    const result = await window.shelfApi.git.worktreeAdd(connection, cwd, branch, true);
    if (!result.ok || !result.path) {
      setError(result.error ?? 'Failed to create worktree');
      setCreating(false);
      return;
    }

    // 2. Migrate the picked note BEFORE the sub-project (and its agent) exists, so
    //    the fresh agent boots with it in place. Fail-loud + roll back the just-
    //    created worktree rather than booting a broken one.
    if (selectedNote) {
      const mig = await window.shelfApi.git.migrateNote(connection, cwd, result.path, [selectedNote]);
      if (!mig.ok) {
        await window.shelfApi.git.worktreeRemove(connection, cwd, result.path);
        setError(mig.error ?? 'Failed to migrate feature note');
        setCreating(false);
        return;
      }
    }

    // 3. Copy the parent's secrets under the new id, then add the sub-project
    //    (inherits parent setup; base is freed; focus jumps).
    const projectId = `wt-${Date.now()}`;
    await window.shelfApi.project.copySecrets(proj.config.id, projectId);
    emit(Events.ADD_PROJECT, buildWorktreeChildConfig(proj.config, {
      id: projectId,
      cwd: result.path,
      worktreeBranch: branch,
      baseBranch: result.baseBranch,
      defaultAgentProvider,
    }));

    // 4. Auto-connect the fresh worktree so its agent boots (and, with a note
    //    seeded, has context to read). Deterministic post-store connect lives in
    //    App, keyed on the store — avoids the bus handlers' stale-projects closure.
    emit(Events.AUTO_CONNECT_PROJECT, projectId);

    setOpen(false);
  }, [input, projectIndex, projects, creating, selectedNote, defaultAgentProvider]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    }
  };

  if (!open) return null;

  const project = projectIndex === null ? undefined : projects[projectIndex];

  return (
    <div className="settings-overlay" onClick={() => setOpen(false)}>
      <div className="worktree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>New Worktree</span>
          <button className="settings-close" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="worktree-dialog-body">
          <div className="worktree-target">
            {project?.config.name ?? 'Unknown project'} @ {baseBranch ?? 'unknown branch'}
          </div>
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
          {notes.length > 0 && (
            <label className="worktree-note-picker">
              <span className="worktree-note-picker-label">Feature note</span>
              <select
                className="worktree-select"
                value={selectedNote}
                onChange={(e) => setSelectedNote(e.target.value)}
                disabled={creating}
              >
                <option value={NO_NOTE}>No note</option>
                {notes.map((n) => {
                  const name = n.title ?? (n.path.split('/').pop() ?? n.path);
                  return (
                    <option key={n.path} value={n.path}>
                      {n.status ? `${name} — ${n.status}` : name}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          <label className="worktree-note-picker">
            <span className="worktree-note-picker-label">Agent provider</span>
            <select
              className="worktree-select"
              value={defaultAgentProvider}
              onChange={(e) => setDefaultAgentProvider(e.target.value as AgentProvider)}
              disabled={creating}
            >
              {agentProviderEntries().map(([id, meta]) => (
                <option key={id} value={id}>{meta.label}</option>
              ))}
            </select>
          </label>
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
