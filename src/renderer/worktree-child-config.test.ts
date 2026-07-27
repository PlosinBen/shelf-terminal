import { describe, it, expect } from 'vitest';
import { buildWorktreeChildConfig } from './worktree-child-config';
import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import type { ProjectConfig } from '@shared/types';

const parent: ProjectConfig = {
  id: 'base-1',
  name: 'My Project',
  cwd: '/repo',
  connection: { type: 'local' },
  maxTabs: 7,
  initScript: 'nvm use',
  envPlain: { FOO: 'bar' },
  defaultTabs: [{ name: 'dev', cmd: 'npm run dev' } as any],
  quickCommands: [{ label: 'build', command: 'npm run build', target: 'current' }],
  defaultAgentProvider: 'claude',
  agentPrefs: { claude: { model: 'opus' } as any },
  openAgentOnConnect: true,
  agentSessionIds: { claude: 'sess-parent' },
};

describe('buildWorktreeChildConfig', () => {
  const child = buildWorktreeChildConfig(parent, {
    id: 'wt-1', cwd: '/repo-feature', worktreeBranch: 'feature', baseBranch: 'main',
  });

  it('inherits the parent setup fields', () => {
    expect(child.name).toBe('My Project');
    expect(child.connection).toEqual({ type: 'local' });
    expect(child.maxTabs).toBe(7);
    expect(child.initScript).toBe('nvm use');
    expect(child.envPlain).toEqual({ FOO: 'bar' });
    expect(child.defaultTabs).toEqual(parent.defaultTabs);
    expect(child.quickCommands).toEqual(parent.quickCommands);
    expect(child.defaultAgentProvider).toBe('claude');
    expect(child.agentPrefs).toEqual(parent.agentPrefs);
    expect(child.openAgentOnConnect).toBe(true);
  });

  it('sets a fresh worktree identity', () => {
    expect(child.id).toBe('wt-1');
    expect(child.cwd).toBe('/repo-feature');
    expect(child.parentProjectId).toBe('base-1');
    expect(child.worktreeBranch).toBe('feature');
    expect(child.baseBranch).toBe('main');
  });

  it('NEVER inherits agentSessionIds (fresh agent boots and reads the note)', () => {
    expect(child.agentSessionIds).toBeUndefined();
  });

  it('uses an explicit provider override without changing the parent', () => {
    const overridden = buildWorktreeChildConfig(parent, {
      id: 'wt-codex', cwd: '/repo-codex', worktreeBranch: 'codex', defaultAgentProvider: 'codex',
    });
    expect(overridden.defaultAgentProvider).toBe('codex');
    expect(parent.defaultAgentProvider).toBe('claude');
  });

  it('accepts the temporary Codex official provider override', () => {
    const overridden = buildWorktreeChildConfig(parent, {
      id: 'wt-codex-official',
      cwd: '/repo-codex-official',
      worktreeBranch: 'codex-official',
      defaultAgentProvider: CODEX_OFFICAL_PROVIDER,
    });
    expect(overridden.defaultAgentProvider).toBe(CODEX_OFFICAL_PROVIDER);
    expect(overridden.agentSessionIds).toBeUndefined();
  });
});
