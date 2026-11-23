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
    defaultTabs: [{ name: 'Terminal' }],
    quickCommands: [],
    featureNoteDir: null,
    parentProjectId,
    worktreeBranch: parentProjectId ? `feature/${id}` : null,
    baseBranch: parentProjectId ? 'main' : null,
    agentViews: {},
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
  projectCleanup: ProjectCleanup = cleanup().value,
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
    await Promise.resolve();
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

  it('rejects an explicitly empty startup list before persistence', async () => {
    const config = persistence();
    const repository = readyRepository(config.value, () => 'new-id');

    await expect(repository.add(createInput({ defaultTabs: [] }))).rejects.toMatchObject({
      name: 'ProjectRepositoryError',
      operation: 'add',
    });
    expect(config.save).not.toHaveBeenCalled();
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

  it('atomically removes a parent and its children and cleans every removed project', async () => {
    const config = persistence([project('a'), project('child', 'a'), project('second', 'a'), project('b')]);
    const projectCleanup = cleanup();
    const capture = vi.fn();
    const repository = readyRepository(config.value, () => 'unused', { ...projectCleanup.value, capture });
    await repository.delete('a');
    expect(repository.getAll()).toEqual([project('b')]);
    expect(config.save).toHaveBeenCalledExactlyOnceWith([project('b')]);
    expect(capture.mock.calls.map(([p]) => p.id)).toEqual(['a', 'child', 'second']);
    expect(projectCleanup.run.mock.calls.map(([id]) => id)).toEqual(['a', 'child', 'second']);
  });

  it('retries failed child cleanup through the removed parent without repeating successful cleanup', async () => {
    const config = persistence([project('a'), project('child', 'a'), project('second', 'a')]);
    const projectCleanup = cleanup();
    projectCleanup.run.mockImplementation(async id => { if (id === 'child') throw new Error('child cleanup failed'); });
    const repository = readyRepository(config.value, () => 'unused', projectCleanup.value);
    await expect(repository.delete('a')).resolves.toEqual({ cleanupPending: true });
    expect(repository.getAll()).toEqual([]);
    expect(projectCleanup.run).toHaveBeenCalledWith('second');
    projectCleanup.run.mockClear().mockResolvedValue(undefined);
    await expect(repository.retryCleanup('a')).resolves.toEqual({ cleanupPending: false });
    expect(projectCleanup.run).toHaveBeenCalledExactlyOnceWith('child');
    expect(config.save).toHaveBeenCalledOnce();
  });

  it('rejects a changed confirmation scope before persistence or cleanup', async () => {
    const config = persistence([project('a'), project('child', 'a')]);
    const projectCleanup = cleanup();
    const repository = readyRepository(config.value, () => 'unused', projectCleanup.value);
    await expect(repository.delete('a', ['a'])).rejects.toThrow('removal scope changed');
    expect(config.save).not.toHaveBeenCalled();
    expect(projectCleanup.run).not.toHaveBeenCalled();
    expect(repository.getAll()).toHaveLength(2);
  });

  it('preserves the full group when deletion cannot persist', async () => {
    const initial = [project('a'), project('child', 'a'), project('b')];
    const config = persistence(initial);
    config.save.mockResolvedValueOnce({ ok: false, error: { stage: 'replace', path: '/config/projects.json', message: 'disk full' } });
    const projectCleanup = cleanup();
    const repository = readyRepository(config.value, () => 'unused', projectCleanup.value);
    await expect(repository.delete('a')).rejects.toBeInstanceOf(ProjectRepositoryError);
    expect(repository.getAll()).toEqual(initial);
    expect(projectCleanup.run).not.toHaveBeenCalled();
  });

  it('removes only the selected child, preserving its parent and siblings', async () => {
    const config = persistence([project('a'), project('child', 'a'), project('second', 'a')]);
    const repository = readyRepository(config.value, () => 'unused');
    await repository.delete('child');
    expect(repository.getAll().map(p => p.id)).toEqual(['a', 'second']);
  });

  it('preserves orphan records when the staged Agent history no longer matches', async () => {
    const orphan = { ...project('child', 'gone'), agentViews: { session: { provider: 'claude', prefs: {} } } };
    const config = persistence([project('main'), orphan]);
    const repo = readyRepository(config.value, () => 'replacement');
    await expect(repo.reconcileWorktrees(repo.getAll(), [], [], () => true, [{ id: orphan.id, sessionIds: [] }]))
      .rejects.toThrow('Agent sessions changed');
    expect(config.save).not.toHaveBeenCalled();
    expect(repo.get(orphan.id)).toEqual(orphan);
  });

  it('saves all staged orphan removals and discoveries together before any cleanup', async () => {
    const config = persistence([project('main'), project('x', 'gone'), project('y', 'gone')]);
    const cleaner = cleanup();
    const repo = readyRepository(config.value, () => 'replacement', cleaner.value);
    const staged = ['x', 'y'].map(id => ({ id, sessionIds: [] }));
    const args = [repo.getAll(), [], [createInput({ parentProjectId: 'main', cwd: '/repo/x' })], () => true, staged] as const;
    config.save.mockResolvedValueOnce({ ok: false, error: { stage: 'replace', path: '/config/projects.json', message: 'disk full' } });
    await expect(repo.reconcileWorktrees(...args)).rejects.toThrow('disk full');
    expect(repo.getAll().map(p => p.id)).toEqual(['main', 'x', 'y']);
    await repo.retryCleanup('x');
    expect(cleaner.run).not.toHaveBeenCalled();
    config.save.mockClear();
    await repo.reconcileWorktrees(...args);
    expect(config.save).toHaveBeenCalledOnce();
    expect(repo.getAll().map(p => p.id)).toEqual(['main', 'replacement']);
    for (const orphan of staged) await repo.retryCleanup(orphan.id);
    expect(cleaner.run.mock.calls.flat()).toEqual(['x', 'y']);
    expect(config.save).toHaveBeenCalledOnce();
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

  it('returns target leftover context for a current-session cleanup retry', async () => {
    const config = persistence([project('a')]);
    const projectCleanup = cleanup();
    const targetError = Object.assign(new Error('target offline'), {
      targetPath: '/home/ben/.shelf/apps/app-1/projects/a',
    });
    projectCleanup.run.mockRejectedValueOnce(new AggregateError([targetError], 'cleanup failed'));
    const repository = readyRepository(config.value, () => 'unused', projectCleanup.value);

    await expect(repository.delete('a')).resolves.toEqual({
      cleanupPending: true,
      leftover: {
        targetPath: '/home/ben/.shelf/apps/app-1/projects/a',
        reason: 'target offline',
      },
    });
  });
});

describe('worktree batch reconciliation', () => {
  it('identifies duplicate main projects without publishing the conflicting scan', async () => {
    const main = { ...project('main-a'), name: 'Same name' };
    const other = { ...project('main-b'), name: main.name, cwd: `${main.cwd}/` };
    const existing = project('existing-child', other.id);
    const config = persistence([main, other, existing]);
    const repo = readyRepository(config.value, () => 'new-child');
    const baseline = repo.getAll();
    const error = await repo.reconcileWorktrees(baseline, [], [createInput({
      parentProjectId: main.id, cwd: existing.cwd,
    })]).catch(error => error);
    expect(error).toBeInstanceOf(ProjectRepositoryError);
    expect(error.message).toContain('Duplicate main projects');
    for (const value of [main.name, main.id, other.id, main.cwd, existing.cwd, existing.id]) {
      expect(error.message).toContain(value);
    }
    expect(error.message).toContain('No scan updates were saved');
    expect(config.save).not.toHaveBeenCalled();
    expect(repo.getAll()).toEqual(baseline);
  });

  it.each(['standalone', 'different-parent'])('does not diagnose duplicate main projects for a %s conflict', async kind => {
    const main = project('main');
    const other = project('other');
    const existing = project('existing', kind === 'standalone' ? null : other.id);
    const config = persistence([main, other, existing]);
    const repo = readyRepository(config.value, () => 'new-child');
    const error = await repo.reconcileWorktrees(repo.getAll(), [], [createInput({
      parentProjectId: main.id, cwd: existing.cwd,
    })]).catch(error => error);
    expect(error.message).toContain('already registered');
    expect(error.message).toContain(existing.id);
    expect(error.message).not.toContain('Duplicate main projects');
    expect(config.save).not.toHaveBeenCalled();
  });

  it('saves a whole batch once and rejects a stale baseline', async () => {
    const config = persistence([project('main')]);
    const repo = readyRepository(config.value, () => 'child');
    const baseline = repo.getAll();
    const input = createInput({ parentProjectId: 'main' });
    await repo.reconcileWorktrees(baseline, [], [input]);
    expect(config.save).toHaveBeenCalledTimes(1);
    expect(repo.get('child')).not.toBeNull();
    expect(await repo.reconcileWorktrees(baseline, [], [input])).toBeNull();
    expect(config.save).toHaveBeenCalledTimes(1);
  });
  it('does not publish a failed batch', async () => {
    const config = persistence([project('main')]);
    const repo = readyRepository(config.value, () => 'child');
    config.save.mockResolvedValueOnce({ ok: false, error: { stage: 'write', message: 'disk full' } } as never);
    await expect(repo.reconcileWorktrees(repo.getAll(), [], [createInput({ parentProjectId: 'main' })])).rejects.toThrow();
    expect(repo.get('child')).toBeNull();
  });
});
it('preserves scan-owned metadata when saving older project preferences', async () => {
  const current = { ...project('child', 'main'), worktreeBranch: null, worktreeState: { availability: 'valid' as const, identity: null } };
  const config = persistence([current]);
  const repo = readyRepository(config.value, () => 'unused');
  await repo.save({ ...project('child', 'main'), name: 'edited' });
  expect(repo.get('child')).toMatchObject({ name: 'edited', worktreeBranch: null, worktreeState: current.worktreeState });
});
