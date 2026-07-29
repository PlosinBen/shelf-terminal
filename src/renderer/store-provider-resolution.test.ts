import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProvider, ProjectConfig } from '@shared/types';
import * as store from './store';

type ProviderResolutionStore = {
  resolveAgentProviderForOpen(projectId: string, explicitProvider?: string): AgentProvider | null;
  resolveAgentProviderForConnect(projectId: string): AgentProvider | null;
};

const providerStore = store as typeof store & ProviderResolutionStore;

function config(
  defaultAgentProvider?: string,
  openAgentOnConnect = false,
): ProjectConfig {
  return {
    id: 'project-1',
    name: 'Project',
    cwd: '/repo/project-1',
    connection: { type: 'local' },
    maxTabs: 5,
    defaultAgentProvider: defaultAgentProvider as AgentProvider | undefined,
    openAgentOnConnect,
  };
}

describe('store provider resolution', () => {
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
    store.setProjects([config('retired-provider')]);

    expect(providerStore.resolveAgentProviderForOpen('project-1', 'codex')).toBe('codex');
  });

  it('uses a registry-valid project default for an implicit open', () => {
    store.setProjects([config('copilot')]);

    expect(providerStore.resolveAgentProviderForOpen('project-1')).toBe('copilot');
  });

  it('returns no provider when an implicit open has no default', () => {
    store.setProjects([config()]);

    expect(providerStore.resolveAgentProviderForOpen('project-1')).toBeNull();
  });

  it('returns no provider when an implicit open has an unknown persisted default', () => {
    store.setProjects([config('retired-provider')]);

    expect(providerStore.resolveAgentProviderForOpen('project-1')).toBeNull();
  });

  it('never falls back to Claude for openAgentOnConnect without a valid default', () => {
    store.setProjects([config('retired-provider', true)]);

    expect(providerStore.resolveAgentProviderForConnect('project-1')).toBeNull();
  });

  it('returns the valid default for openAgentOnConnect only when enabled', () => {
    store.setProjects([config('codex', true)]);
    expect(providerStore.resolveAgentProviderForConnect('project-1')).toBe('codex');

    store.setProjects([config('codex', false)]);
    expect(providerStore.resolveAgentProviderForConnect('project-1')).toBeNull();
  });
});
