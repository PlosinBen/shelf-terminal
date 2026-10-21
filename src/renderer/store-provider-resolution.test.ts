import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PROVIDER } from '@shared/agent-providers';
import type { Project } from '@shared/projects';
import * as store from './store';

function config(): Project {
  return {
    id: 'project-1',
    name: 'Project',
    cwd: '/repo/project-1',
    connection: { type: 'local' },
    maxTabs: 5,
    initScript: null,
    envPlain: {},
    defaultTabs: [{ name: 'Terminal' }],
    quickCommands: [],
    featureNoteDir: null,
    parentProjectId: null,
    worktreeBranch: null,
    baseBranch: null,
    agentSessionIds: {},
    agentPrefs: {},
  };
}

describe('store provider validation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      shelfApi: {
        project: { save: vi.fn() },
      },
    });
    store.__resetStoreForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.__resetStoreForTests();
  });

  it('uses an explicitly requested registry-valid provider', () => {
    store.setProjects([config()]);

    expect(store.validateAgentProviderForOpen('project-1', CODEX_PROVIDER)).toBe(CODEX_PROVIDER);
  });

  it('returns no provider when explicit intent omits the provider', () => {
    store.setProjects([config()]);

    expect(store.validateAgentProviderForOpen('project-1', undefined)).toBeNull();
  });

  it('returns no provider for an unknown explicit provider', () => {
    store.setProjects([config()]);

    expect(store.validateAgentProviderForOpen('project-1', 'retired-provider')).toBeNull();
  });

  it('returns no provider for an unknown project', () => {
    expect(store.validateAgentProviderForOpen('missing', CODEX_PROVIDER)).toBeNull();
  });
});
