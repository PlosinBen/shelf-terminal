import { describe, expect, it, vi } from 'vitest';
import { createProjectCleanup } from './project-cleanup';
import type { Project } from '@shared/projects';

const project: Project = {
  id: 'project-a', name: 'Project A', cwd: '/work', connection: { type: 'local' },
  maxTabs: 5, initScript: null, envPlain: {}, defaultTabs: [{ name: 'Terminal' }], quickCommands: [],
  featureNoteDir: null, parentProjectId: null, worktreeBranch: null, baseBranch: null,
  agentViews: {},
};

describe('project cleanup', () => {
  it('cleans project storage without a separate secret cleanup operation', async () => {
    const removeStorage = vi.fn(async () => {});
    const cleanup = createProjectCleanup({ removeStorage });

    await cleanup.cleanup('project-a');

    expect(removeStorage).toHaveBeenCalledWith('project-a');
  });

  it('reports storage cleanup failure for retry', async () => {
    const removeStorage = vi.fn(async () => {
      throw new Error('storage failed');
    });
    const cleanup = createProjectCleanup({ removeStorage });

    await expect(cleanup.cleanup('project-a')).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: 'storage failed' })],
    });
    expect(removeStorage).toHaveBeenCalledOnce();
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
    });
    cleanup.capture?.(project);

    await cleanup.cleanup(project.id);

    expect(order).toEqual(['teardown', 'history', 'storage']);
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
