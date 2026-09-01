import { describe, expect, it, vi } from 'vitest';
import { createProjectCleanup } from './project-cleanup';
import type { Project } from '@shared/projects';

const project: Project = {
  id: 'project-a', name: 'Project A', cwd: '/work', connection: { type: 'local' },
  maxTabs: 5, initScript: null, envPlain: {}, defaultTabs: [], quickCommands: [],
  featureNoteDir: null, parentProjectId: null, worktreeBranch: null, baseBranch: null,
  defaultAgentProvider: null, openAgentOnConnect: false, agentSessionIds: {}, agentPrefs: {},
};

describe('project cleanup', () => {
  it('attempts storage and secrets cleanup in the same run', async () => {
    const removeStorage = vi.fn(async () => {});
    const removeSecrets = vi.fn(() => {});
    const cleanup = createProjectCleanup({ removeStorage, removeSecrets });

    await cleanup.cleanup('project-a');

    expect(removeStorage).toHaveBeenCalledWith('project-a');
    expect(removeSecrets).toHaveBeenCalledWith('project-a');
  });

  it('reports failure after still attempting both cleanup targets', async () => {
    const removeStorage = vi.fn(async () => {
      throw new Error('storage failed');
    });
    const removeSecrets = vi.fn(() => {
      throw new Error('secrets failed');
    });
    const cleanup = createProjectCleanup({ removeStorage, removeSecrets });

    await expect(cleanup.cleanup('project-a')).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(removeStorage).toHaveBeenCalledOnce();
    expect(removeSecrets).toHaveBeenCalledOnce();
  });

  it('tears down sessions before target history and leaves local cleanup last', async () => {
    const order: string[] = [];
    const runtime = { homePath: vi.fn(async () => '/home/ben'), exec: vi.fn() } as any;
    const cleanup = createProjectCleanup({
      appId: () => 'app-1',
      createRuntime: () => runtime,
      teardownProject: async () => { order.push('teardown'); return { confirmed: true, unconfirmedTabIds: [] }; },
      removeTargetHistory: async () => { order.push('history'); return '/target/history'; },
      removeStorage: async () => { order.push('storage'); },
      removeSecrets: async () => { order.push('secrets'); },
    });
    cleanup.capture?.(project);

    await cleanup.cleanup(project.id);

    expect(order).toEqual(['teardown', 'history', 'storage', 'secrets']);
  });

  it('retains target cleanup for current-session retry when terminal exit is unconfirmed', async () => {
    const teardownProject = vi.fn()
      .mockResolvedValueOnce({ confirmed: false, unconfirmedTabIds: ['tab-1'] })
      .mockResolvedValueOnce({ confirmed: true, unconfirmedTabIds: [] });
    const removeTargetHistory = vi.fn(async () => '/target/history');
    const runtime = { homePath: vi.fn(async () => '/home/ben'), exec: vi.fn() } as any;
    const cleanup = createProjectCleanup({
      appId: () => 'app-1',
      createRuntime: () => runtime,
      teardownProject,
      removeTargetHistory,
      removeStorage: async () => {},
      removeSecrets: async () => {},
    });
    cleanup.capture?.(project);

    await expect(cleanup.cleanup(project.id)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({
        targetPath: '/home/ben/.shelf/apps/app-1/projects/project-a',
      })],
    });
    expect(removeTargetHistory).not.toHaveBeenCalled();

    await expect(cleanup.cleanup(project.id)).resolves.toBeUndefined();
    expect(removeTargetHistory).toHaveBeenCalledOnce();
  });
});
