import { describe, expect, it, vi } from 'vitest';
import { log } from '@shared/logger';
import type { Project } from '@shared/projects';
import type { ProjectConfigFileIo } from './project-config-file-io';
import { createProjectConfigPersistence } from './project-config-persistence';

function project(): Project {
  return {
    id: 'a',
    name: 'A',
    cwd: '/repo/a',
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

function io(overrides: Partial<ProjectConfigFileIo> = {}): ProjectConfigFileIo {
  return {
    read: () => ({ ok: true, state: 'missing' }),
    backup: async () => ({ ok: true }),
    writeAtomic: async () => ({ ok: true }),
    ...overrides,
  };
}

describe('project config persistence', () => {
  it('maps a missing file to an empty canonical collection', async () => {
    const persistence = createProjectConfigPersistence('/config/projects.json', io());

    expect(await persistence.load()).toEqual({ ok: true, value: [] });
  });

  it('loads legacy data through the codec', async () => {
    const fileIo = io({
      read: vi.fn(() => ({
        ok: true as const,
        state: 'present' as const,
        data: new TextEncoder().encode(JSON.stringify([{
          id: 'a', name: 'A', cwd: '/repo/a', connection: { type: 'local' }, maxTabs: 5,
        }])),
      })),
    });
    const persistence = createProjectConfigPersistence('/config/projects.json', fileIo);

    expect(await persistence.load()).toEqual({ ok: true, value: [project()] });
  });

  it('adds filepath and codec stage to invalid-data failures', async () => {
    const fileIo = io({
      read: vi.fn(() => ({
        ok: true as const,
        state: 'present' as const,
        data: new TextEncoder().encode('{'),
      })),
    });
    const persistence = createProjectConfigPersistence('/config/projects.json', fileIo);

    const result = await persistence.load();

    expect(result).toMatchObject({
      ok: false,
      error: { path: '/config/projects.json', stage: 'parse' },
    });
  });

  it('formats an empty collection as the current envelope before writing', async () => {
    const writeAtomic = vi.fn<ProjectConfigFileIo['writeAtomic']>(async () => ({ ok: true }));
    const persistence = createProjectConfigPersistence('/config/projects.json', io({ writeAtomic }));

    expect(await persistence.save([])).toEqual({ ok: true });
    expect(writeAtomic).toHaveBeenCalledOnce();
    expect(JSON.parse(writeAtomic.mock.calls[0][1] as string)).toEqual({
      schemaVersion: 1,
      projects: [],
    });
  });

  it('propagates atomic write failures without reporting success', async () => {
    const persistence = createProjectConfigPersistence('/config/projects.json', io({
      writeAtomic: vi.fn(async () => ({
        ok: false,
        error: {
          operation: 'replace' as const,
          kind: 'io' as const,
          path: '/config/projects.json',
          message: 'disk full',
        },
      })),
    }));

    expect(await persistence.save([project()])).toMatchObject({
      ok: false,
      error: { stage: 'replace', path: '/config/projects.json' },
    });
  });

  it.each([
    ['legacy v0', JSON.stringify([{ id: 'a', name: 'A', cwd: '/repo/a', connection: { type: 'local' }, maxTabs: 5 }])],
    ['current v1', JSON.stringify({ schemaVersion: 1, projects: [project()] })],
  ])('backs up raw %s data before replacing a non-empty collection with empty v1', async (_label, data) => {
    const backup = vi.fn<ProjectConfigFileIo['backup']>(async () => ({ ok: true }));
    const fileIo = io({
      read: () => ({ ok: true, state: 'present', data: new TextEncoder().encode(data) }),
      backup,
    });
    const persistence = createProjectConfigPersistence(
      '/config/projects.json',
      fileIo,
      { now: () => new Date(2026, 7, 8, 12, 34, 56) },
    );
    expect(persistence.load().ok).toBe(true);

    await persistence.save([]);

    expect(backup).toHaveBeenCalledWith(
      '/config/projects.json',
      '/config/projects.json.backup.20260808-123456',
    );
  });

  it('logs backup failure and still surfaces the atomic write result', async () => {
    const writeAtomic = vi.fn<ProjectConfigFileIo['writeAtomic']>(async () => ({ ok: true }));
    const error = vi.spyOn(log, 'error');
    const persistence = createProjectConfigPersistence('/config/projects.json', io({
      read: () => ({
        ok: true,
        state: 'present',
        data: new TextEncoder().encode(JSON.stringify([{
          id: 'a', name: 'A', cwd: '/repo/a', connection: { type: 'local' }, maxTabs: 5,
        }])),
      }),
      backup: vi.fn<ProjectConfigFileIo['backup']>(async () => ({
        ok: false,
        error: { operation: 'backup', kind: 'io', path: '/config/projects.json', message: 'copy failed' },
      })),
      writeAtomic,
    }));
    persistence.load();

    await expect(persistence.save([])).resolves.toEqual({ ok: true });
    expect(writeAtomic).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      'projects-persistence',
      expect.stringContaining('copy failed'),
    );
  });
});
