import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/projects';
import type { RendererProjectsRepositoryClient } from './projects-repository-client';
import { createProjectMutationCoordinator } from './project-mutation-coordinator';

function project(id: string): Project {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    connection: { type: 'local' },
    maxTabs: 5,
    initScript: null,
    envPlain: {},
    defaultTabs: [],
    quickCommands: [],
    featureNoteDir: null,
    parentProjectId: null,
    worktreeBranch: null,
    baseBranch: null,
    defaultAgentProvider: null,
    openAgentOnConnect: false,
    agentSessionIds: {},
    agentPrefs: {},
  };
}

function client() {
  const value: RendererProjectsRepositoryClient = {
    getAll: vi.fn(async () => []),
    getInvalidDirectoryIds: vi.fn(async () => []),
    add: vi.fn(),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => ({ cleanupPending: false })),
    retryCleanup: vi.fn(async () => ({ cleanupPending: false })),
    reorder: vi.fn(async () => {}),
  };
  return value;
}

describe('project mutation coordinator', () => {
  it('publishes add only after durable mutation and authoritative refresh', async () => {
    const repository = client();
    let commit: ((project: Project) => void) | undefined;
    vi.mocked(repository.add).mockImplementation(() => new Promise((resolve) => {
      commit = resolve;
    }));
    vi.mocked(repository.getAll).mockResolvedValue([project('main-id')]);
    const reconcile = vi.fn();
    const coordinator = createProjectMutationCoordinator(repository, {
      getProject: () => null,
      reconcile,
    });

    const adding = coordinator.add({
      name: 'A', cwd: '/repo/a', connection: { type: 'local' }, maxTabs: 5,
    });
    expect(repository.getAll).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();

    commit?.(project('main-id'));
    await expect(adding).resolves.toEqual(project('main-id'));
    expect(repository.getAll).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith([project('main-id')]);
  });

  it('builds a full canonical save from current store state', async () => {
    const repository = client();
    vi.mocked(repository.getAll).mockResolvedValue([{ ...project('a'), name: 'Renamed' }]);
    const reconcile = vi.fn();
    const coordinator = createProjectMutationCoordinator(repository, {
      getProject: () => project('a'),
      reconcile,
    });

    await coordinator.save('a', { name: 'Renamed' });

    expect(repository.save).toHaveBeenCalledWith({ ...project('a'), name: 'Renamed' });
    expect(reconcile).toHaveBeenCalledWith([{ ...project('a'), name: 'Renamed' }]);
  });

  it('keeps store state untouched when a mutation fails', async () => {
    const repository = client();
    vi.mocked(repository.delete).mockRejectedValue(new Error('disk full'));
    const reconcile = vi.fn();
    const coordinator = createProjectMutationCoordinator(repository, {
      getProject: () => project('a'),
      reconcile,
    });

    await expect(coordinator.delete('a')).rejects.toThrow('disk full');
    expect(repository.getAll).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('refreshes before returning delete partial success', async () => {
    const repository = client();
    vi.mocked(repository.delete).mockResolvedValue({ cleanupPending: true });
    const reconcile = vi.fn();
    const coordinator = createProjectMutationCoordinator(repository, {
      getProject: () => project('a'),
      reconcile,
    });

    await expect(coordinator.delete('a')).resolves.toEqual({ cleanupPending: true });
    expect(repository.getAll).toHaveBeenCalledOnce();
    expect(vi.mocked(repository.delete).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(repository.getAll).mock.invocationCallOrder[0]);
    expect(vi.mocked(repository.getAll).mock.invocationCallOrder[0])
      .toBeLessThan(reconcile.mock.invocationCallOrder[0]);
  });
});
