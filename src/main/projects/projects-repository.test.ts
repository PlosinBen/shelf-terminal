import { beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@shared/logger';
import type { Project, ProjectCreateInput } from '@shared/projects';
import type { ProjectConfigPersistence } from './project-config-persistence';
import type { ProjectCleanup } from './project-cleanup';
import {
  ProjectRepositoryError,
  createMainProjectsRepository,
} from './projects-repository';

function project(id: string, parentProjectId: string | null = null): Project {
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
    parentProjectId,
    worktreeBranch: parentProjectId ? `feature/${id}` : null,
    baseBranch: parentProjectId ? 'main' : null,
    defaultAgentProvider: null,
    openAgentOnConnect: false,
    agentSessionIds: {},
    agentPrefs: {},
  };
}

function createInput(overrides: Partial<ProjectCreateInput> = {}): ProjectCreateInput {
  return {
    name: 'generated-id',
    cwd: '/repo/generated-id',
    connection: { type: 'local' },
    maxTabs: 5,
    ...overrides,
  };
}

function persistence(initial: readonly Project[] = []) {
  const save = vi.fn<ProjectConfigPersistence['save']>(async () => ({ ok: true }));
  const value: ProjectConfigPersistence = {
    load: vi.fn(() => ({ ok: true as const, value: initial })),
    save,
  };
  return { value, save };
}

function cleanup() {
  const run = vi.fn<ProjectCleanup['cleanup']>(async () => {});
  return { value: { cleanup: run } satisfies ProjectCleanup, run };
}

function readyRepository(
  config: ProjectConfigPersistence,
  createProjectId: () => string,
  projectCleanup = cleanup().value,
) {
  const result = createMainProjectsRepository(config, createProjectId, projectCleanup);
  if (!result.ok) throw new Error(`unexpected load failure: ${result.error.message}`);
  return result.repository;
}

describe('main projects repository', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not create a ready repository when config load fails', () => {
    const config: ProjectConfigPersistence = {
      load: vi.fn(() => ({
        ok: false as const,
        error: { stage: 'parse' as const, path: '/config/projects.json', message: 'bad JSON' },
      })),
      save: vi.fn(),
    };

    expect(createMainProjectsRepository(config, () => 'unused', cleanup().value)).toMatchObject({
      ok: false,
      error: { stage: 'parse' },
    });
  });

  it('owns identity, defaults, detached state, and durable-before-publish add', async () => {
    const config = persistence();
    let resolveSave: ((value: { ok: true }) => void) | undefined;
    config.save.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const repository = readyRepository(config.value, () => 'generated-id');
    const input = createInput();

    const adding = repository.add(input);
    expect(repository.getAll()).toEqual([]);
    resolveSave?.({ ok: true });
    const added = await adding;

    expect(added).toEqual(project('generated-id'));
    expect(repository.getAll()).toEqual([project('generated-id')]);
    expect(Object.isFrozen(repository.getAll())).toBe(true);
    expect(Object.isFrozen(repository.get('generated-id')?.connection)).toBe(true);
  });

  it('keeps authoritative state unchanged when add persistence fails', async () => {
    const config = persistence([project('existing')]);
    config.save.mockResolvedValueOnce({
      ok: false,
      error: { stage: 'replace', path: '/config/projects.json', message: 'disk full' },
    });
    const repository = readyRepository(config.value, () => 'new-id');

    await expect(repository.add(createInput())).rejects.toBeInstanceOf(ProjectRepositoryError);
    expect(repository.getAll()).toEqual([project('existing')]);
  });

  it('rejects a duplicate effective target before persistence', async () => {
    const existing = project('existing');
    const config = persistence([existing]);
    const repository = readyRepository(config.value, () => 'new-id');

    await expect(repository.add(createInput({
      cwd: `${existing.cwd}/`,
      connection: existing.connection,
    }))).rejects.toMatchObject({
      name: 'ProjectRepositoryError',
      operation: 'add',
    });
    expect(config.save).not.toHaveBeenCalled();
    expect(repository.getAll()).toEqual([existing]);
  });

  it('allows the same cwd on a distinct connection target', async () => {
    const existing = project('existing');
    const config = persistence([existing]);
    const repository = readyRepository(config.value, () => 'new-id');

    await expect(repository.add(createInput({
      cwd: existing.cwd,
      connection: { type: 'docker', container: 'dev' },
    }))).resolves.toMatchObject({ id: 'new-id' });
    expect(config.save).toHaveBeenCalledOnce();
  });

  it('loads and saves existing duplicate targets without retroactive validation', async () => {
    const first = project('first');
    const second = { ...project('second'), cwd: `${first.cwd}/` };
    const config = persistence([first, second]);
    const repository = readyRepository(config.value, () => 'unused');

    await expect(repository.save({ ...first, name: 'renamed' })).resolves.toBeUndefined();
    expect(config.save).toHaveBeenCalledWith([
      { ...first, name: 'renamed' },
      second,
    ]);
  });

  it('treats identical and missing saves as non-persisting no-ops', async () => {
    const config = persistence([project('a')]);
    const warn = vi.spyOn(log, 'warn');
    const repository = readyRepository(config.value, () => 'unused');

    await repository.save(project('a'));
    await repository.save(project('missing'));

    expect(config.save).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'projects-repository',
      expect.stringContaining('operation=save projectId=missing'),
    );
  });

  it('deletes durably and treats a missing id as a successful no-op', async () => {
    const config = persistence([project('a'), project('b')]);
    const projectCleanup = cleanup();
    const repository = readyRepository(config.value, () => 'unused', projectCleanup.value);

    await expect(repository.delete('missing')).resolves.toEqual({ cleanupPending: false });
    expect(config.save).not.toHaveBeenCalled();

    await expect(repository.delete('a')).resolves.toEqual({ cleanupPending: false });
    expect(config.save).toHaveBeenLastCalledWith([project('b')]);
    expect(repository.getAll()).toEqual([project('b')]);
    expect(projectCleanup.run).toHaveBeenCalledWith('a');
    await expect(repository.retryCleanup('a')).resolves.toEqual({ cleanupPending: false });
  });

  it('moves whole worktree groups and skips same-group reorder', async () => {
    const initial = [project('a'), project('a-child', 'a'), project('b')];
    const config = persistence(initial);
    const repository = readyRepository(config.value, () => 'unused');

    await repository.reorder('a', 'a-child');
    expect(config.save).not.toHaveBeenCalled();

    await repository.reorder('a', 'b');
    expect(repository.getAll().map(({ id }) => id)).toEqual(['b', 'a', 'a-child']);
    expect(config.save).toHaveBeenCalledOnce();
  });

  it('publishes a durable delete before returning cleanup pending and retries cleanup only', async () => {
    const config = persistence([project('a'), project('b')]);
    const projectCleanup = cleanup();
    projectCleanup.run
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce(undefined);
    const repository = readyRepository(
      config.value,
      () => 'unused',
      projectCleanup.value,
    );

    await expect(repository.delete('a')).resolves.toEqual({ cleanupPending: true });
    expect(repository.getAll()).toEqual([project('b')]);
    expect(config.save).toHaveBeenCalledOnce();

    await expect(repository.retryCleanup('a')).resolves.toEqual({ cleanupPending: false });
    expect(projectCleanup.run).toHaveBeenCalledTimes(2);
    expect(config.save).toHaveBeenCalledOnce();
    await expect(repository.retryCleanup('a')).resolves.toEqual({ cleanupPending: false });
    expect(projectCleanup.run).toHaveBeenCalledTimes(2);
  });

  it('does not start cleanup when delete persistence fails', async () => {
    const config = persistence([project('a')]);
    config.save.mockResolvedValueOnce({
      ok: false,
      error: { stage: 'replace', path: '/config/projects.json', message: 'disk full' },
    });
    const projectCleanup = cleanup();
    const repository = readyRepository(
      config.value,
      () => 'unused',
      projectCleanup.value,
    );

    await expect(repository.delete('a')).rejects.toBeInstanceOf(ProjectRepositoryError);
    expect(repository.getAll()).toEqual([project('a')]);
    expect(projectCleanup.run).not.toHaveBeenCalled();
  });
});
