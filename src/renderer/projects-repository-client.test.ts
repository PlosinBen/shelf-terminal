import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectCreateInput } from '@shared/projects';
import { createRendererProjectsRepositoryClient } from './projects-repository-client';

const input: ProjectCreateInput = {
  name: 'A', cwd: '/repo/a', connection: { type: 'local' }, maxTabs: 5,
};
const project = { id: 'a', ...input } as Project;

describe('renderer projects repository client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps canonical operations to the project IPC bridge', async () => {
    const api = {
      getAll: vi.fn(async () => [project]),
      validateDirs: vi.fn(async () => ['a']),
      add: vi.fn(async () => project),
      update: vi.fn(async () => {}),
      delete: vi.fn(async () => ({ cleanupPending: false })),
      retryCleanup: vi.fn(async () => ({ cleanupPending: false })),
      reorder: vi.fn(async () => {}),
    };
    vi.stubGlobal('window', { shelfApi: { project: api } });
    const client = createRendererProjectsRepositoryClient();

    await expect(client.getAll()).resolves.toEqual([project]);
    await expect(client.getInvalidDirectoryIds()).resolves.toEqual(['a']);
    await client.add(input);
    await client.save(project);
    await client.delete('a');
    await client.retryCleanup('a');
    await client.reorder('a', 'b');

    expect(api.validateDirs).toHaveBeenCalledWith();
    expect(api.add).toHaveBeenCalledWith(input);
    expect(api.update).toHaveBeenCalledWith(project);
    expect(api.delete).toHaveBeenCalledWith('a');
    expect(api.retryCleanup).toHaveBeenCalledWith('a');
    expect(api.reorder).toHaveBeenCalledWith('a', 'b');
  });
});
