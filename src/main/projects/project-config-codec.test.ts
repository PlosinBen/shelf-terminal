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

  it('loads a current v1 envelope from Uint8Array', () => {
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
    ['unsupported future version', JSON.stringify({ schemaVersion: 2, projects: [] }), 'schema'],
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
  it('writes an empty canonical collection as a v1 envelope', () => {
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
      defaultAgentProvider: 'future-provider',
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

  it('rejects a runtime-invalid canonical value', () => {
    const invalid = { ...project(), maxTabs: 0 };

    const result = formatProjectsDocument([invalid]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context).toBe('projects[0].maxTabs');
  });
});
