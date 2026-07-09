import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setProjects } from './app-state';
import type { ProjectConfig } from '@shared/types';

// secret-store pulls in electron (safeStorage/app) — mock it so this suite stays
// electron-free. Per-test behavior is set via the mock fn below.
const resolveProjectSecrets = vi.fn((_projectId: string) => ({}) as Record<string, string>);
vi.mock('./secret-store', () => ({ resolveProjectSecrets: (id: string) => resolveProjectSecrets(id) }));

// Import AFTER the mock is registered.
const { resolveProjectEnv } = await import('./project-env');

function project(id: string, envPlain?: Record<string, string>): ProjectConfig {
  return {
    id, name: id, cwd: '/tmp', connection: { type: 'local' }, maxTabs: 4, envPlain,
  } as ProjectConfig;
}

describe('resolveProjectEnv', () => {
  beforeEach(() => {
    setProjects([]);
    resolveProjectSecrets.mockReturnValue({});
  });

  it('returns {} for an unknown or absent projectId', () => {
    expect(resolveProjectEnv(undefined)).toEqual({});
    expect(resolveProjectEnv('nope')).toEqual({});
  });

  it('returns the project plain env map', () => {
    setProjects([project('p1', { GH_TOKEN: 'abc', HTTPS_PROXY: 'http://x' })]);
    expect(resolveProjectEnv('p1')).toEqual({ GH_TOKEN: 'abc', HTTPS_PROXY: 'http://x' });
  });

  it('drops reserved keys as a backstop', () => {
    setProjects([project('p1', { GH_TOKEN: 'abc', SHELF_TEST_MODE: '1', ELECTRON_RUN_AS_NODE: '1' })]);
    expect(resolveProjectEnv('p1')).toEqual({ GH_TOKEN: 'abc' });
  });

  it('returns {} when the project has no envPlain', () => {
    setProjects([project('p1')]);
    expect(resolveProjectEnv('p1')).toEqual({});
  });

  it('merges plain + secret, secret winning a same-key collision', () => {
    setProjects([project('p1', { PLAIN_ONLY: 'p', SHARED: 'plain-val' })]);
    resolveProjectSecrets.mockReturnValue({ SECRET_ONLY: 's', SHARED: 'secret-val' });
    expect(resolveProjectEnv('p1')).toEqual({
      PLAIN_ONLY: 'p', SECRET_ONLY: 's', SHARED: 'secret-val',
    });
  });
});
