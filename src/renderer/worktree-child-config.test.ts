import { describe, it, expect } from 'vitest';
import { buildWorktreeChildConfig } from './worktree-child-config';
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
  defaultTabs: [{ name: 'dev', cmd: 'npm run dev' } as any],
  quickCommands: [{ label: 'build', command: 'npm run build', target: 'current' }],
  featureNoteDir: '.agent/features',
  defaultAgentProvider: CLAUDE_PROVIDER,
  agentPrefs: { [CLAUDE_PROVIDER]: { model: 'opus' } as any },
  openAgentOnConnect: true,
  agentSessionIds: { [CLAUDE_PROVIDER]: 'sess-parent' },
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
  const child = buildWorktreeChildConfig(parent, {
    cwd: '/repo-feature', worktreeBranch: 'feature', baseBranch: 'main',
  });

  it('inherits the parent setup fields', () => {
    expect(child.name).toBe('My Project');
    expect(child.connection).toEqual({ type: 'local' });
    expect(child.maxTabs).toBe(7);
    expect(child.initScript).toBe('nvm use');
    expect(child.envPlain).toEqual({ FOO: 'bar' });
    expect(child.defaultTabs).toEqual(parent.defaultTabs);
    expect(child.quickCommands).toEqual(parent.quickCommands);
    expect(child.featureNoteDir).toBe('.agent/features');
    expect(child.defaultAgentProvider).toBe(CLAUDE_PROVIDER);
    expect(child.agentPrefs).toEqual(parent.agentPrefs);
    expect(child.openAgentOnConnect).toBe(true);
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

  it('uses an explicit provider override without changing the parent', () => {
    const overridden = buildWorktreeChildConfig(parent, {
      cwd: '/repo-codex', worktreeBranch: 'feature-codex', defaultAgentProvider: CODEX_PROVIDER,
    });
    expect(overridden.defaultAgentProvider).toBe(CODEX_PROVIDER);
    expect(parent.defaultAgentProvider).toBe(CLAUDE_PROVIDER);
  });

  it('accepts the canonical Codex provider override', () => {
    const overridden = buildWorktreeChildConfig(parent, {
      cwd: '/repo-codex-official',
      worktreeBranch: 'codex-official',
      defaultAgentProvider: CODEX_PROVIDER,
    });
    expect(overridden.defaultAgentProvider).toBe(CODEX_PROVIDER);
    expect(overridden).not.toHaveProperty('agentSessionIds');
  });
});
