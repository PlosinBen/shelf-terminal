import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import { on, emit, emitAgent, Events } from '../events';
import { enqueuePendingSend } from '../agentTabStore';
import { debugLog } from '../debugLog';
import { buildWorktreeChildConfig } from '../worktree-child-config';
import { normalizeWorktreePrefillNotePaths } from '../worktree-prefill';
import type { AgentProvider, FeatureNoteInfo } from '@shared/types';
import { agentProviderEntries } from '@shared/agent-providers';

function featureNoteFilename(path: string): string {
  return path.split('/').pop() ?? path;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logCreateFailure(input: {
  projectId: string;
  branch: string;
  baseCwd: string;
  worktreePath?: string;
  failedStep: string;
  error: string;
}) {
  debugLog('worktree-create', JSON.stringify({ operation: 'create', ...input }));
}

function buildCreateFailurePrompt(input: {
  branch: string;
  baseCwd: string;
  worktreePath?: string;
  migrationError?: string;
  rollbackError?: string;
  setupError?: string;
  createError?: string;
}) {
  const lines = [
    'The worktree create flow failed. Please inspect the repository/worktree state and repair it so I can retry Create.',
    '',
    `Branch: ${input.branch}`,
    `Base cwd: ${input.baseCwd}`,
    `Attempted worktree path: ${input.worktreePath ?? '(not returned)'}`,
  ];
  if (input.createError) lines.push('', `Create error:\n${input.createError}`);
  if (input.migrationError) lines.push('', `Migration error:\n${input.migrationError}`);
  if (input.rollbackError) lines.push('', `Rollback error:\n${input.rollbackError}`);
  if (input.setupError) lines.push('', `Setup error:\n${input.setupError}`);
  return lines.join('\n');
}

export function WorktreeDialog() {
  const { projects } = useStore();
  const [open, setOpen] = useState(false);
  const [projectIndex, setProjectIndex] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failurePrompt, setFailurePrompt] = useState<string | null>(null);
  // In-progress feature notes in the base repo, offered as the handoff seed. The
  // checked notes are migrated into the worktree before its agent boots.
  const [notes, setNotes] = useState<FeatureNoteInfo[]>([]);
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(() => new Set());
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [defaultAgentProvider, setDefaultAgentProvider] = useState<AgentProvider>('claude');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const off = on(Events.CREATE_WORKTREE, (index: number, prefill?: { branch?: string; notePaths?: string[] }) => {
      const prefilledNotePaths = normalizeWorktreePrefillNotePaths(prefill?.notePaths);
      setProjectIndex(index);
      setOpen(true);
      setInput(prefill?.branch ?? '');
      setError(null);
      setFailurePrompt(null);
      setCreating(false);
      setNotes([]);
      setSelectedNotes(new Set(prefilledNotePaths));
      setBaseBranch(null);

      // Fetch the base repo's in-progress notes for the picker. Pre-select when
      // there's exactly one (the common case: one feature under discussion);
      // otherwise default to none so the user chooses deliberately.
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
            if (prefilledNotePaths.length === 0 && found.length === 1) setSelectedNotes(new Set([found[0].path]));
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
    setFailurePrompt(null);
    const { connection, cwd } = proj.config;

    // 1. Create the worktree (captures the parent's baseBranch atomically).
    const result = await window.shelfApi.git.worktreeAdd(connection, cwd, branch, true);
    if (!result.ok || !result.path) {
      const createError = result.error ?? 'Failed to create worktree';
      logCreateFailure({
        projectId: proj.config.id,
        branch,
        baseCwd: cwd,
        worktreePath: result.path,
        failedStep: 'worktreeAdd',
        error: createError,
      });
      setError(createError);
      setFailurePrompt(buildCreateFailurePrompt({ branch, baseCwd: cwd, worktreePath: result.path, createError }));
      setCreating(false);
      return;
    }

    // 2. Migrate the picked note BEFORE the sub-project (and its agent) exists, so
    //    the fresh agent boots with it in place. Fail-loud + roll back the just-
    //    created worktree rather than booting a broken one.
    const selectedNotePaths = Array.from(selectedNotes);
    if (selectedNotePaths.length > 0) {
      const mig = await window.shelfApi.git.migrateNote(connection, cwd, result.path, selectedNotePaths);
      if (!mig.ok) {
        const migrationError = mig.error ?? 'Failed to migrate feature notes';
        logCreateFailure({
          projectId: proj.config.id,
          branch,
          baseCwd: cwd,
          worktreePath: result.path,
          failedStep: 'migrateNote',
          error: migrationError,
        });
        const rollback = await window.shelfApi.git.worktreeRemove(connection, cwd, result.path);
        const rollbackError = rollback.ok ? undefined : (rollback.error ?? 'Failed to remove worktree after note migration failure');
        if (rollbackError) {
          logCreateFailure({
            projectId: proj.config.id,
            branch,
            baseCwd: cwd,
            worktreePath: result.path,
            failedStep: 'rollbackWorktreeRemove',
            error: rollbackError,
          });
        }
        const fullError = rollbackError
          ? `Failed to migrate feature notes:\n\n${migrationError}\n\nRollback also failed:\n\n${rollbackError}`
          : `Failed to migrate feature notes:\n\n${migrationError}`;
        setError(fullError);
        setFailurePrompt(buildCreateFailurePrompt({
          branch,
          baseCwd: cwd,
          worktreePath: result.path,
          migrationError,
          rollbackError,
        }));
        setCreating(false);
        return;
      }
    }

    // 3. Copy the parent's secrets under the new id, then add the sub-project
    //    (inherits parent setup; base is freed; focus jumps).
    const projectId = `wt-${Date.now()}`;
    try {
      await window.shelfApi.project.copySecrets(proj.config.id, projectId);
      emit(Events.ADD_PROJECT, buildWorktreeChildConfig(proj.config, {
        id: projectId,
        cwd: result.path,
        worktreeBranch: branch,
        baseBranch: result.baseBranch,
        defaultAgentProvider,
      }));
    } catch (err) {
      const setupError = errorText(err);
      logCreateFailure({
        projectId: proj.config.id,
        branch,
        baseCwd: cwd,
        worktreePath: result.path,
        failedStep: 'setupChildProject',
        error: setupError,
      });
      setError(`Worktree was created, but setup failed:\n\n${setupError}`);
      setFailurePrompt(buildCreateFailurePrompt({ branch, baseCwd: cwd, worktreePath: result.path, setupError }));
      setCreating(false);
      return;
    }

    // 4. Auto-connect the fresh worktree so its agent boots (and, with a note
    //    seeded, has context to read). Deterministic post-store connect lives in
    //    App, keyed on the store — avoids the bus handlers' stale-projects closure.
    emit(Events.AUTO_CONNECT_PROJECT, projectId);

    setOpen(false);
  }, [input, projectIndex, projects, creating, selectedNotes, defaultAgentProvider]);

  const toggleSelectedNote = useCallback((path: string) => {
    setSelectedNotes((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

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
  const agentTabId = project?.tabs.find((t) => t.type === 'agent')?.id;

  const sendFailureToAgent = () => {
    if (!agentTabId || !failurePrompt) return;
    const clientMsgId = crypto.randomUUID();
    enqueuePendingSend(agentTabId, clientMsgId, failurePrompt);
    emitAgent('agent:send', { tabId: agentTabId, text: failurePrompt, clientMsgId });
    setOpen(false);
  };

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
            <div className="worktree-note-picker">
              <span className="worktree-note-picker-label">Feature note</span>
              <div className="worktree-note-list">
                {notes.map((n) => {
                  const filename = featureNoteFilename(n.path);
                  const checked = selectedNotes.has(n.path);
                  return (
                    <label key={n.path} className="worktree-note-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelectedNote(n.path)}
                        disabled={creating}
                      />
                      <span className="worktree-note-row-main">
                        <span className="worktree-note-heading">
                          <span className="worktree-note-filename">{filename}</span>
                          {n.status && <span className="worktree-note-status">{n.status}</span>}
                        </span>
                        {n.title && <span className="worktree-note-title">{n.title}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
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
          {error && (
            <div className="worktree-error">
              <pre className="worktree-error-text">{error}</pre>
              {failurePrompt && (
                <div className="worktree-error-actions">
                  <button
                    className="conn-btn conn-btn-next"
                    onClick={sendFailureToAgent}
                    disabled={!agentTabId}
                    title={agentTabId ? 'Send this error to the base project agent' : 'No agent tab open in the base project'}
                  >
                    Send to agent
                  </button>
                </div>
              )}
            </div>
          )}
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
