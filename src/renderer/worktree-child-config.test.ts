import { describe, it, expect } from 'vitest';
import { buildWorktreeChildConfig } from './worktree-child-config';
import { resolveWorktreeAgentSource } from '@shared/worktree-child-config';
import { CLAUDE_PROVIDER, CODEX_PROVIDER } from '@shared/agent-providers';
import type { Project } from '@shared/projects';

const parent: Project = {
  id: 'base-1',
  name: 'My Project',
  cwd: '/repo',
  connection: { type: 'local' },
  maxTabs: 7,
  initScript: 'nvm use',
  envPlain: { FOO: 'bar' },
  defaultTabs: [
    { name: 'Claude', kind: 'agent', provider: CLAUDE_PROVIDER },
    { name: 'dev', cmd: 'npm run dev' },
  ],
  quickCommands: [{ label: 'build', command: 'npm run build', target: 'current' }],
  featureNoteDir: '.agent/features',
  agentViews: { 'sess-parent': { provider: CLAUDE_PROVIDER, prefs: { model: 'opus' } } },
  parentProjectId: null,
  worktreeBranch: null,
  baseBranch: null,
};

/**
 * Promise rationale: child creation is a cross-session handoff boundary. The
 * child must preserve reproducible project setup while receiving fresh identity
 * and agent state; these assertions are contract behavior, not clone mechanics.
 * If they change, review the Create UI, proposal-tool description, worktree
 * lifecycle context, and shelf-worktree-handoff skill together.
 */
describe('buildWorktreeChildConfig', () => {
  it('selects a matching caller/active View, otherwise only an unambiguous matching source', () => {
    const withViews = { ...parent, agentViews: {
      a: { provider: CODEX_PROVIDER, prefs: { nativePermission: ':workspace' } },
      b: { provider: CODEX_PROVIDER, prefs: { nativePermission: ':full-access' } },
      c: { provider: CLAUDE_PROVIDER, prefs: { model: 'opus' } },
    } };
    expect(resolveWorktreeAgentSource(withViews, CODEX_PROVIDER, 'b')).toBe('b');
    expect(resolveWorktreeAgentSource(withViews, CODEX_PROVIDER)).toBeUndefined();
    expect(resolveWorktreeAgentSource(withViews, CLAUDE_PROVIDER, 'b')).toBe('c');
    expect(resolveWorktreeAgentSource(parent, CODEX_PROVIDER)).toBeUndefined();
    const child = buildWorktreeChildConfig(withViews, { cwd: '/child', worktreeBranch: 'child',
      startupAgentProvider: CODEX_PROVIDER, sourceAgentSessionId: 'b' });
    expect(child.worktreeAgentSourceSessionId).toBe('b');
    expect(child).not.toHaveProperty('agentViews');
    expect(() => buildWorktreeChildConfig(withViews, { cwd: '/child', worktreeBranch: 'child',
      startupAgentProvider: CLAUDE_PROVIDER, sourceAgentSessionId: 'b' })).toThrow(/source/i);
  });
  const child = buildWorktreeChildConfig(parent, {
    cwd: '/repo-feature', worktreeBranch: 'feature', baseBranch: 'main',
  });

  it('inherits the parent setup fields', () => {
    expect(child.name).toBe('My Project');
    expect(child.connection).toEqual({ type: 'local' });
    expect(child.maxTabs).toBe(7);
    expect(child.initScript).toBe('nvm use');
    expect(child.envPlain).toEqual({ FOO: 'bar' });
    expect(child.defaultTabs).toEqual([{ name: 'Terminal' }]);
    expect(child.quickCommands).toEqual(parent.quickCommands);
    expect(child.featureNoteDir).toBe('.agent/features');
    expect(child).not.toHaveProperty('agentPrefs');
  });

  it('sets a fresh worktree identity', () => {
    expect(child).not.toHaveProperty('id');
    expect(child.cwd).toBe('/repo-feature');
    expect(child.parentProjectId).toBe('base-1');
    expect(child.worktreeBranch).toBe('feature');
    expect(child.baseBranch).toBe('main');
  });

  it('NEVER inherits agentSessionIds (the child starts with fresh agent state)', () => {
    expect(child).not.toHaveProperty('agentSessionIds');
  });

  it('snapshots featureNoteDir without linking later parent edits', () => {
    const editableParent = { ...parent };
    const snapshotted = buildWorktreeChildConfig(editableParent, {
      cwd: '/repo-snapshot', worktreeBranch: 'snapshot',
    });
    editableParent.featureNoteDir = 'notes/features';
    expect(snapshotted.featureNoteDir).toBe('.agent/features');
  });

  it('replaces the complete inherited list when a startup Agent override is selected', () => {
    const overridden = buildWorktreeChildConfig(parent, {
      cwd: '/repo-codex',
      worktreeBranch: 'feature-codex',
      startupAgentProvider: CODEX_PROVIDER,
    });

    expect(overridden.defaultTabs).toEqual([
      { name: 'Codex', kind: 'agent', provider: CODEX_PROVIDER },
      { name: 'Terminal' },
    ]);
    expect(parent.defaultTabs).toEqual([
      { name: 'Claude', kind: 'agent', provider: CLAUDE_PROVIDER },
      { name: 'dev', cmd: 'npm run dev' },
    ]);
    expect(overridden.quickCommands).toEqual(parent.quickCommands);
    expect(overridden).not.toHaveProperty('agentSessionIds');
  });

  it('supports Agent only without inheriting parent records or prefs', () => {
    const child = buildWorktreeChildConfig(parent, {
      cwd: '/repo-agent', worktreeBranch: 'agent',
      startupAgentProvider: CODEX_PROVIDER, startupTerminal: false,
    });
    expect(child.defaultTabs).toEqual([{ name: 'Codex', kind: 'agent', provider: CODEX_PROVIDER }]);
    expect(child).not.toHaveProperty('agentViews');
    expect(child).not.toHaveProperty('agentPrefs');
  });

  it('rejects a selection with neither Agent nor Terminal', () => {
    expect(() => buildWorktreeChildConfig(parent, {
      cwd: '/repo-empty', worktreeBranch: 'empty', startupTerminal: false,
    })).toThrow('Select at least one initial view');
  });

});
