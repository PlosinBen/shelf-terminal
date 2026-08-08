import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import type { Project, ProjectCreateInput } from '@shared/projects';
import type { MainProjectsRepository } from '../projects/projects-repository';

type Handler = (event: unknown, ...args: any[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
}));

const repository: MainProjectsRepository = {
  getAll: vi.fn(),
  get: vi.fn(),
  add: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  retryCleanup: vi.fn(),
  reorder: vi.fn(),
};

vi.mock('../projects/repository-provider', () => ({
  getProjectsRepository: () => repository,
}));
vi.mock('../secret-store', () => ({
  listProjectSecretKeys: vi.fn(),
  setProjectSecret: vi.fn(),
  deleteProjectSecret: vi.fn(),
  copyProjectSecrets: vi.fn(),
  getKeyTier: vi.fn(),
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
    await handlers.get(IPC.PROJECT_UPDATE)?.({}, canonical);
    await handlers.get(IPC.PROJECT_DELETE)?.({}, 'a');
    await handlers.get(IPC.PROJECT_RETRY_CLEANUP)?.({}, 'a');
    await handlers.get(IPC.PROJECT_REORDER)?.({}, 'a', 'b');

    expect(repository.getAll).toHaveBeenCalledOnce();
    expect(repository.add).toHaveBeenCalledWith(input);
    expect(repository.save).toHaveBeenCalledWith(canonical);
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
});
