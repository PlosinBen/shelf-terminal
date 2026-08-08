import { describe, expect, it, vi } from 'vitest';
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
    read: async () => ({ ok: true, state: 'missing' }),
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
      read: vi.fn(async () => ({
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
      read: vi.fn(async () => ({
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
});
