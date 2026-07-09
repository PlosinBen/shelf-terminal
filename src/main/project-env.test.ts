import { describe, it, expect, beforeEach } from 'vitest';
import { setProjects } from './app-state';
import { resolveProjectEnv } from './project-env';
import type { ProjectConfig } from '@shared/types';

function project(id: string, envPlain?: Record<string, string>): ProjectConfig {
  return {
    id, name: id, cwd: '/tmp', connection: { type: 'local' }, maxTabs: 4, envPlain,
  } as ProjectConfig;
}

describe('resolveProjectEnv', () => {
  beforeEach(() => setProjects([]));

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
});
