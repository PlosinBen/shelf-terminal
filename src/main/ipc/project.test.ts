import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import type { Project, ProjectCreateInput } from '@shared/projects';
import type { MainProjectsRepository } from '../projects/projects-repository';
import { PROJECT_MUTATION } from '@shared/project-mutations';

type Handler = (event: unknown, ...args: any[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
}));

const repository: MainProjectsRepository = {
  reconcileWorktrees: vi.fn(),
  getAll: vi.fn(),
  get: vi.fn(),
  add: vi.fn(),
  save: vi.fn(),
  mutate: vi.fn(),
  delete: vi.fn(),
  retryCleanup: vi.fn(),
  reorder: vi.fn(),
};

vi.mock('../projects/repository-provider', () => ({
  getProjectsRepository: () => repository,
}));

const { registerProjectHandlers } = await import('./project');

function project(id: string, cwd = `/repo/${id}`): Project {
  return {
    id,
    name: id,
    cwd,
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
    agentViews: {},
  };
}

describe('project IPC repository mapping', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerProjectHandlers();
  });

  it('maps canonical queries and mutations directly to repository operations', async () => {
    const input: ProjectCreateInput = {
      name: 'A', cwd: '/repo/a', connection: { type: 'local' }, maxTabs: 5,
    };
    const canonical = project('a');

    await handlers.get(IPC.PROJECT_GET_ALL)?.({});
    await handlers.get(IPC.PROJECT_ADD)?.({}, input);
    const mutation = { kind: PROJECT_MUTATION.EDIT, edits: [{ field: 'name' as const, before: 'a', value: 'A' }] };
    await handlers.get(IPC.PROJECT_UPDATE)?.({}, canonical.id, mutation);
    await handlers.get(IPC.PROJECT_DELETE)?.({}, 'a');
    await handlers.get(IPC.PROJECT_RETRY_CLEANUP)?.({}, 'a');
    await handlers.get(IPC.PROJECT_REORDER)?.({}, 'a', 'b');

    expect(repository.getAll).toHaveBeenCalledOnce();
    expect(repository.add).toHaveBeenCalledWith(input);
    expect(repository.mutate).toHaveBeenCalledWith(canonical.id, mutation);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.delete).toHaveBeenCalledWith('a');
    expect(repository.retryCleanup).toHaveBeenCalledWith('a');
    expect(repository.reorder).toHaveBeenCalledWith('a', 'b');
  });

  it('validates local directories from repository state without a renderer snapshot', () => {
    vi.mocked(repository.getAll).mockReturnValue([
      project('valid', '/exists'),
      project('missing', '/missing'),
      { ...project('remote'), connection: { type: 'ssh', host: 'host', port: 22, user: 'ben' } },
    ]);
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => filePath === '/exists');

    const result = handlers.get(IPC.PROJECT_VALIDATE_DIRS)?.({});

    expect(result).toEqual(['missing']);
    expect(repository.getAll).toHaveBeenCalledOnce();
  });

  it('does not expose the retired project secret operations', () => {
    for (const channel of ['project:secrets-list', 'project:secret-set', 'project:secret-delete', 'project:secrets-copy', 'secret:key-tier']) {
      expect(handlers.has(channel), channel).toBe(false);
    }
  });
});
