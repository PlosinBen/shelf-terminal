import { describe, expect, it } from 'vitest';
import type { Project } from '@shared/projects';
import {
  PROJECTS_SCHEMA_VERSION,
  formatProjectsDocument,
  loadProjectsDocument,
} from './project-config-codec';

function project(id = 'project-a'): Project {
  return {
    id,
    name: 'Project A',
    cwd: '/repo/a',
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
    agentSessionIds: {},
    agentPrefs: {},
  };
}

describe('project config loader', () => {
  it('normalizes a legacy v0 root array into canonical projects', () => {
    const result = loadProjectsDocument(JSON.stringify([{
      id: 'legacy',
      name: 'Legacy',
      cwd: '/repo/legacy',
      connection: { type: 'ssh', host: 'example.com', port: 22, user: 'ben' },
      maxTabs: 7,
    }]));

    expect(result).toEqual({
      ok: true,
      value: [{
        ...project('legacy'),
        name: 'Legacy',
        cwd: '/repo/legacy',
        connection: { type: 'ssh', host: 'example.com', port: 22, user: 'ben' },
        maxTabs: 7,
      }],
    });
  });

  it('loads a current v2 envelope from Uint8Array', () => {
    const input = project();
    const data = new TextEncoder().encode(JSON.stringify({
      schemaVersion: PROJECTS_SCHEMA_VERSION,
      projects: [input],
    }));

    expect(loadProjectsDocument(data)).toEqual({ ok: true, value: [input] });
  });

  it.each([
    ['malformed JSON', '{', 'parse'],
    ['wrong root shape', '{}', 'schema'],
    ['unsupported future version', JSON.stringify({ schemaVersion: PROJECTS_SCHEMA_VERSION + 1, projects: [] }), 'schema'],
    ['invalid connection', JSON.stringify([{
      id: 'bad', name: 'Bad', cwd: '/bad', connection: { type: 'ssh', host: 'x' }, maxTabs: 5,
    }]), 'schema'],
    ['duplicate id', JSON.stringify([
      { id: 'same', name: 'A', cwd: '/a', connection: { type: 'local' }, maxTabs: 5 },
      { id: 'same', name: 'B', cwd: '/b', connection: { type: 'local' }, maxTabs: 5 },
    ]), 'schema'],
  ])('rejects %s', (_label, data, stage) => {
    const result = loadProjectsDocument(data);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.stage).toBe(stage);
  });
});

describe('project config formatter', () => {
  it('writes an empty canonical collection as a v2 envelope', () => {
    const result = formatProjectsDocument([]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.data)).toEqual({
        schemaVersion: PROJECTS_SCHEMA_VERSION,
        projects: [],
      });
    }
  });

  it('round-trips canonical content and order', () => {
    const projects = [project('b'), project('a')];
    const formatted = formatProjectsDocument(projects);
    expect(formatted.ok).toBe(true);
    if (!formatted.ok) return;

    expect(loadProjectsDocument(formatted.data)).toEqual({ ok: true, value: projects });
  });

  it('round-trips unknown provider ids as opaque data', () => {
    const input: Project = {
      ...project(),
      defaultTabs: [{ name: 'future-provider', kind: 'agent', provider: 'future-provider' }],
      agentSessionIds: { 'retired-provider': 'session-1' },
      agentPrefs: {
        'future-provider': {
          model: 'future-model',
          permissionMode: 'custom',
          nativeMode: 'autopilot',
          nativePermission: 'allow-all',
        },
      },
    };

    const formatted = formatProjectsDocument([input]);
    expect(formatted.ok).toBe(true);
    if (!formatted.ok) return;

    expect(loadProjectsDocument(formatted.data)).toEqual({ ok: true, value: [input] });
  });

  it.each([true, false])('migrates a saved v1 provider regardless of openAgentOnConnect=%s', (openAgentOnConnect) => {
    const legacy = {
      ...project(),
      defaultTabs: [],
      defaultAgentProvider: 'claude',
      openAgentOnConnect,
    };
    const result = loadProjectsDocument(JSON.stringify({ schemaVersion: 1, projects: [legacy] }));

    expect(result).toMatchObject({
      ok: true,
      value: [{ defaultTabs: [
        { name: 'Claude', kind: 'agent', provider: 'claude' },
        { name: 'Terminal' },
      ] }],
    });
  });

  it.each([true, false])('ignores openAgentOnConnect=%s when v1 has no provider', (openAgentOnConnect) => {
    const legacy = {
      ...project(),
      defaultTabs: [],
      defaultAgentProvider: null,
      openAgentOnConnect,
    };
    const result = loadProjectsDocument(JSON.stringify({ schemaVersion: 1, projects: [legacy] }));

    expect(result).toMatchObject({ ok: true, value: [{ defaultTabs: [{ name: 'Terminal' }] }] });
  });

  it('rejects empty and duplicate-provider v2 startup lists', () => {
    const empty = loadProjectsDocument(JSON.stringify({
      schemaVersion: 2,
      projects: [{ ...project(), defaultTabs: [] }],
    }));
    expect(empty).toMatchObject({ ok: false, error: { context: 'projects[0].defaultTabs' } });

    const duplicate = formatProjectsDocument([{
      ...project(),
      defaultTabs: [
        { name: 'one', kind: 'agent', provider: 'claude' },
        { name: 'two', kind: 'agent', provider: 'claude' },
      ],
    }]);
    expect(duplicate).toMatchObject({
      ok: false,
      error: { context: 'projects[0].defaultTabs[1].provider' },
    });
  });

  it('rejects a runtime-invalid canonical value', () => {
    const invalid = { ...project(), maxTabs: 0 };

    const result = formatProjectsDocument([invalid]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context).toBe('projects[0].maxTabs');
  });
});

describe('persisted worktree availability', () => {
  it('round-trips unavailable worktrees without losing their last identity', () => {
    const value = { ...project(), worktreeState: { availability: 'missing' as const, identity: { checkoutPath: '/child', gitDir: '/repo/.git/worktrees/child', commonDir: '/repo/.git' } } };
    const formatted = formatProjectsDocument([value]);
    expect(formatted.ok).toBe(true);
    if (!formatted.ok) throw new Error('format failed');
    const loaded = loadProjectsDocument(formatted.data);
    expect(loaded).toMatchObject({ ok: true, value: [value] });
  });
  it('rejects corrupted availability instead of silently enabling a project', () => {
    expect(loadProjectsDocument(JSON.stringify({ version: PROJECTS_SCHEMA_VERSION, projects: [{ ...project(), worktreeState: { availability: 'garbage', identity: null } }] })).ok).toBe(false);
  });
});


describe('Codex native prefs migration', () => {
  it.each([0, 1, 2])('migrates version %s once without changing other providers', (version) => {
    for (const [permissionMode, nativePermission, nativeApproval] of [
      ['default', ':workspace', 'on-request'],
      ['plan', ':read-only', 'never'],
      ['bypassPermissions', ':danger-full-access', 'never'],
    ]) {
      const input = { ...project(), ...(version < 2 ? { defaultAgentProvider: null, openAgentOnConnect: false } : {}),
        agentPrefs: { codex: { permissionMode, model: 'm', effort: 'ultra' }, claude: { permissionMode } } };
      const loaded = loadProjectsDocument(JSON.stringify(version === 0 ? [input] : { schemaVersion: version, projects: [input] }));
      expect(loaded).toMatchObject({ ok: true, value: [{ agentPrefs: {
        codex: { nativePermission, nativeApproval, model: 'm', effort: 'ultra' }, claude: { permissionMode },
      } }] });
      if (!loaded.ok) throw new Error('load failed');
      expect(loaded.value[0].agentPrefs.codex).not.toHaveProperty('permissionMode');
      expect(loaded.value[0].agentPrefs.codex).not.toHaveProperty('nativeMode');
      const formatted = formatProjectsDocument(loaded.value);
      if (!formatted.ok) throw new Error('format failed');
      expect(JSON.parse(formatted.data).schemaVersion).toBe(3);
      expect(loadProjectsDocument(formatted.data)).toEqual(loaded);
    }
  });

  it('preserves existing native intent and rejects unknown legacy permissions', () => {
    const input = { ...project(), agentPrefs: { codex: { permissionMode: 'plan', nativePermission: ':workspace', nativeApproval: 'untrusted' } } };
    expect(loadProjectsDocument(JSON.stringify({ schemaVersion: 2, projects: [input] }))).toMatchObject({
      ok: true, value: [{ agentPrefs: { codex: { nativePermission: ':workspace', nativeApproval: 'untrusted' } } }],
    });
    input.agentPrefs.codex.permissionMode = 'unknown';
    expect(loadProjectsDocument(JSON.stringify({ schemaVersion: 2, projects: [input] }))).toMatchObject({
      ok: false, error: { context: 'projects[0].agentPrefs.codex.permissionMode' },
    });
  });
});
