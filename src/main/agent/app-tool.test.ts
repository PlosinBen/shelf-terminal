import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectConfig } from '@shared/types';

const listSkills = vi.fn();
const getSkill = vi.fn();
const createSkill = vi.fn();
const updateSkill = vi.fn();
const deleteSkill = vi.fn();
const isSkillLocked = vi.fn();
const listSkillAuxFiles = vi.fn();
const readSkillFile = vi.fn();
const writeSkillFile = vi.fn();
const deleteSkillFile = vi.fn();
const resolveAuxPath = vi.fn();
vi.mock('../skills-store', () => ({
  listSkills: (...a: unknown[]) => listSkills(...a),
  getSkill: (...a: unknown[]) => getSkill(...a),
  createSkill: (...a: unknown[]) => createSkill(...a),
  updateSkill: (...a: unknown[]) => updateSkill(...a),
  deleteSkill: (...a: unknown[]) => deleteSkill(...a),
  isSkillLocked: (...a: unknown[]) => isSkillLocked(...a),
  listSkillAuxFiles: (...a: unknown[]) => listSkillAuxFiles(...a),
  readSkillFile: (...a: unknown[]) => readSkillFile(...a),
  writeSkillFile: (...a: unknown[]) => writeSkillFile(...a),
  deleteSkillFile: (...a: unknown[]) => deleteSkillFile(...a),
  resolveAuxPath: (...a: unknown[]) => resolveAuxPath(...a),
}));
const onSkillsChanged = vi.fn();
vi.mock('../skills-sync', () => ({ onSkillsChanged: () => onSkillsChanged() }));

const requestWebPermission = vi.fn();
const requestBrowserOpen = vi.fn();
const openWebTab = vi.fn();
const webFetch = vi.fn();
const isGranted = vi.fn();
const grant = vi.fn();
vi.mock('../web-permission', () => ({
  requestWebPermission: (...a: unknown[]) => requestWebPermission(...a),
}));
vi.mock('../browser-open', () => ({
  requestBrowserOpen: (...a: unknown[]) => requestBrowserOpen(...a),
  openWebTab: (...a: unknown[]) => openWebTab(...a),
}));
vi.mock('../web-session', () => ({
  webFetch: (...a: unknown[]) => webFetch(...a),
}));
vi.mock('../web-grants', () => ({
  isGranted: (...a: unknown[]) => isGranted(...a),
  grant: (...a: unknown[]) => grant(...a),
}));

const getProjects = vi.fn();
const getMainWindow = vi.fn();
vi.mock('../app-state', () => ({
  getMainWindow: () => getMainWindow(),
}));
vi.mock('../projects/repository-provider', () => ({
  getProjectsRepository: () => ({
    get: (projectId: string) => (getProjects() as ProjectConfig[])
      .find((project) => project.id === projectId) ?? null,
  }),
}));

const createConnector = vi.fn();
vi.mock('../connector', () => ({ createConnector: (...args: unknown[]) => createConnector(...args) }));
const listFeatureNotes = vi.fn();
vi.mock('../worktree/feature-notes', () => ({
  listFeatureNotes: (...args: unknown[]) => listFeatureNotes(...args),
}));

import { handleAppTool, isSafeAppToolOp, isKnownAppToolOp } from './app-tool';

beforeEach(() => {
  listSkills.mockReset();
  getSkill.mockReset();
  createSkill.mockReset();
  updateSkill.mockReset();
  deleteSkill.mockReset();
  isSkillLocked.mockReset();
  listSkillAuxFiles.mockReset();
  readSkillFile.mockReset();
  writeSkillFile.mockReset();
  deleteSkillFile.mockReset();
  resolveAuxPath.mockReset();
  onSkillsChanged.mockReset();
  getProjects.mockReset();
  getMainWindow.mockReset();
  requestWebPermission.mockReset();
  requestBrowserOpen.mockReset();
  openWebTab.mockReset();
  webFetch.mockReset();
  isGranted.mockReset();
  grant.mockReset();
  createConnector.mockReset();
  listFeatureNotes.mockReset();
});

describe('app-tool dispatcher (browser prompt ownership)', () => {
  it('passes the source project to the web.fetch permission prompt', async () => {
    isGranted.mockReturnValue(false);
    requestWebPermission.mockResolvedValue('once');
    webFetch.mockResolvedValue({ status: 200, headers: {}, body: 'ok' });

    const result = await handleAppTool(
      'web.fetch',
      { url: 'https://kibana.corp.com/api/status' },
      { projectId: 'project-b' },
    );

    expect(result.ok).toBe(true);
    expect(requestWebPermission).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-b' }));
  });

  it('passes the source project to browser_open and opens the tab there', async () => {
    requestBrowserOpen.mockResolvedValue('open');

    const result = await handleAppTool(
      'web.open',
      { url: 'https://kibana.corp.com/login' },
      { projectId: 'project-b' },
    );

    expect(result.ok).toBe(true);
    expect(requestBrowserOpen).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-b' }));
    expect(openWebTab).toHaveBeenCalledWith('project-b', 'https://kibana.corp.com/login');
  });

  it.each(['web.fetch', 'web.open'])('%s fails loudly without a project context', async (op) => {
    const result = await handleAppTool(op, { url: 'https://kibana.corp.com/login' });

    expect(result).toEqual({ ok: false, error: `${op} requires a project context` });
  });
});

describe('app-tool dispatcher (worktree proposals)', () => {
  const send = vi.fn();

  beforeEach(() => {
    getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: { send } });
    const connector = { exec: vi.fn() };
    createConnector.mockReturnValue(connector);
    getProjects.mockReturnValue([
      {
        id: 'base', name: 'Base', cwd: '/repo', connection: { type: 'local' },
        featureNoteDir: '.agent/features',
      },
      {
        id: 'child', name: 'Feature', cwd: '/repo-feature', connection: { type: 'local' },
        parentProjectId: 'base', featureNoteDir: '.agent/features',
      },
    ]);
    listFeatureNotes.mockResolvedValue({
      ok: true,
      notes: [
        { path: '.agent/features/worktree-flow.md' },
        { path: '.agent/features/a.md' },
        { path: '.agent/features/b.md' },
        { path: '.agent/features/c.md' },
      ],
    });
    send.mockReset();
  });

  it('propose_create opens a prefilled dialog without a git side effect', async () => {
    const r = await handleAppTool('worktree.propose_create', { branch: 'feature/worktree', note: '.agent/features/worktree-flow.md' }, { projectId: 'base' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      opened: true,
      branch: 'feature/worktree',
      notePaths: ['.agent/features/worktree-flow.md'],
    });
    expect(send).toHaveBeenCalledWith('worktree:propose-create', {
      projectId: 'base', branch: 'feature/worktree', notePaths: ['.agent/features/worktree-flow.md'],
    });
  });

  it('propose_create accepts empty args and sends normalized notePaths', async () => {
    const r = await handleAppTool('worktree.propose_create', { branch: '   ', note: '   ', notes: ['', '  '] }, { projectId: 'base' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ opened: true, notePaths: [] });
    expect(send).toHaveBeenCalledWith('worktree:propose-create', {
      projectId: 'base', notePaths: [],
    });
  });

  it('propose_create merges legacy note and notes into deduped notePaths', async () => {
    const r = await handleAppTool('worktree.propose_create', {
      branch: ' feature/multi ',
      note: ' .agent/features/a.md ',
      notes: [
        '.agent/features/b.md',
        ' .agent/features/a.md ',
        '',
        42,
        '.agent/features/c.md',
      ],
    }, { projectId: 'base' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      opened: true,
      branch: 'feature/multi',
      notePaths: ['.agent/features/a.md', '.agent/features/b.md', '.agent/features/c.md'],
    });
    expect(send).toHaveBeenCalledWith('worktree:propose-create', {
      projectId: 'base',
      branch: 'feature/multi',
      notePaths: ['.agent/features/a.md', '.agent/features/b.md', '.agent/features/c.md'],
    });
  });

  it('propose_create resolves a unique basename to its canonical configured path', async () => {
    const r = await handleAppTool('worktree.propose_create', {
      note: 'worktree-flow.md',
    }, { projectId: 'base' });

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ notePaths: ['.agent/features/worktree-flow.md'] });
    expect(listFeatureNotes).toHaveBeenCalledWith(
      expect.anything(),
      '/repo',
      '.agent/features',
    );
  });

  it('propose_create dedupes exact and basename identifiers after canonicalization', async () => {
    const r = await handleAppTool('worktree.propose_create', {
      note: '.agent/features/a.md',
      notes: ['a.md'],
    }, { projectId: 'base' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ notePaths: ['.agent/features/a.md'] });
  });

  it('propose_create rejects explicit notes when the integration is disabled', async () => {
    getProjects.mockReturnValue([{ id: 'base', name: 'Base', cwd: '/repo', connection: { type: 'local' } }]);
    const r = await handleAppTool('worktree.propose_create', { note: 'a.md' }, { projectId: 'base' });
    expect(r).toEqual({
      ok: false,
      error: 'cannot propose feature notes: this project has no feature note directory configured',
    });
    expect(send).not.toHaveBeenCalled();
    expect(listFeatureNotes).not.toHaveBeenCalled();
  });

  it('propose_create rejects unknown and ambiguous identifiers without opening the dialog', async () => {
    listFeatureNotes.mockResolvedValueOnce({ ok: true, notes: [] });
    const unknown = await handleAppTool('worktree.propose_create', { note: 'missing.md' }, { projectId: 'base' });
    expect(unknown).toEqual({ ok: false, error: 'feature note not found: missing.md' });

    listFeatureNotes.mockResolvedValueOnce({
      ok: true,
      notes: [{ path: 'one/same.md' }, { path: 'two/same.md' }],
    });
    const ambiguous = await handleAppTool('worktree.propose_create', { note: 'same.md' }, { projectId: 'base' });
    expect(ambiguous).toEqual({ ok: false, error: 'ambiguous feature note identifier: same.md' });
    expect(send).not.toHaveBeenCalled();
  });

  it('propose_create preserves listing failures when explicit notes require validation', async () => {
    listFeatureNotes.mockResolvedValue({ ok: false, error: 'remote permission denied' });
    const r = await handleAppTool('worktree.propose_create', { note: 'a.md' }, { projectId: 'base' });
    expect(r).toEqual({ ok: false, error: 'cannot list configured feature notes: remote permission denied' });
    expect(send).not.toHaveBeenCalled();
  });

  it('propose_finish opens the gate for a worktree', async () => {
    const r = await handleAppTool('worktree.propose_finish', {}, { projectId: 'child' });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith('worktree:propose-finish', { projectId: 'child' });
  });

  it('propose_finish fails loudly outside a worktree and sends no IPC', async () => {
    const r = await handleAppTool('worktree.propose_finish', {}, { projectId: 'base' });
    expect(r).toEqual({ ok: false, error: 'Base is not a worktree — nothing to finish' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('app-tool dispatcher (read ops)', () => {
  it('app_skill.list → { skills } from skills-store', async () => {
    listSkills.mockResolvedValue([{ name: 'a' }, { name: 'b', description: 'B' }]);
    const r = await handleAppTool('app_skill.list');
    expect(r).toEqual({ ok: true, data: { skills: [{ name: 'a' }, { name: 'b', description: 'B' }] } });
  });

  it('app_skill.get → { name, content, files } (aux files surfaced)', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nbody');
    listSkillAuxFiles.mockResolvedValue(['scripts/build.sh']);
    const r = await handleAppTool('app_skill.get', { name: 'foo' });
    expect(r).toEqual({ ok: true, data: { name: 'foo', content: '---\nname: foo\n---\nbody', files: ['scripts/build.sh'] } });
    expect(getSkill).toHaveBeenCalledWith('foo');
  });

  it('app_skill.get without a name → ok:false (no throw)', async () => {
    const r = await handleAppTool('app_skill.get', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name/);
    expect(getSkill).not.toHaveBeenCalled();
  });

  it('app_skill.get for a missing skill → ok:false', async () => {
    getSkill.mockResolvedValue(null);
    const r = await handleAppTool('app_skill.get', { name: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it('unknown op → ok:false, never throws', async () => {
    const r = await handleAppTool('app_skill.frobnicate', {});
    expect(r).toEqual({ ok: false, error: 'unknown app_tool op: app_skill.frobnicate' });
  });

  it('a throwing handler is caught into ok:false (never throws to caller)', async () => {
    listSkills.mockRejectedValue(new Error('disk gone'));
    const r = await handleAppTool('app_skill.list');
    expect(r).toEqual({ ok: false, error: 'disk gone' });
  });

  it('registry flags: reads are safe, writes are not; delete is not exposed', () => {
    expect(isSafeAppToolOp('app_skill.list')).toBe(true);
    expect(isSafeAppToolOp('app_skill.get')).toBe(true);
    expect(isSafeAppToolOp('app_skill.read_file')).toBe(true);
    expect(isSafeAppToolOp('app_skill.create')).toBe(false); // mutation → confirm
    expect(isSafeAppToolOp('app_skill.update')).toBe(false);
    expect(isSafeAppToolOp('app_skill.write_file')).toBe(false);
    expect(isSafeAppToolOp('app_skill.delete_file')).toBe(false);
    expect(isKnownAppToolOp('app_skill.create')).toBe(true);
    expect(isKnownAppToolOp('app_skill.delete')).toBe(false); // whole-skill delete: never exposed to the agent
  });
});

describe('app-tool dispatcher (aux-file ops)', () => {
  it('read_file → { name, path, content }', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb'); // skill exists
    resolveAuxPath.mockReturnValue('/abs/foo/scripts/build.sh'); // valid path
    readSkillFile.mockResolvedValue('#!/bin/sh');
    const r = await handleAppTool('app_skill.read_file', { name: 'foo', path: 'scripts/build.sh' });
    expect(r).toEqual({ ok: true, data: { name: 'foo', path: 'scripts/build.sh', content: '#!/bin/sh' } });
  });

  it('read_file on a missing skill → ok:false (never reads)', async () => {
    getSkill.mockResolvedValue(null);
    const r = await handleAppTool('app_skill.read_file', { name: 'ghost', path: 'a.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
    expect(readSkillFile).not.toHaveBeenCalled();
  });

  it('read_file on a reserved/invalid path → ok:false distinct from a missing file', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    resolveAuxPath.mockReturnValue(null); // guard rejects (e.g. SKILL.md / ..)
    const r = await handleAppTool('app_skill.read_file', { name: 'foo', path: 'SKILL.md' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid or reserved/);
    expect(readSkillFile).not.toHaveBeenCalled();
  });

  it('read_file on an absent file → ok:false (file not found)', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    resolveAuxPath.mockReturnValue('/abs/foo/nope.txt');
    readSkillFile.mockResolvedValue(null);
    const r = await handleAppTool('app_skill.read_file', { name: 'foo', path: 'nope.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file not found/);
  });

  it('write_file writes + fires onSkillsChanged, returns { name, path }', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb'); // exists
    isSkillLocked.mockReturnValue(false);
    writeSkillFile.mockResolvedValue({ ok: true });
    const r = await handleAppTool('app_skill.write_file', { name: 'foo', path: 'scripts/build.sh', content: 'echo hi' });
    expect(r).toEqual({ ok: true, data: { name: 'foo', path: 'scripts/build.sh' } });
    expect(writeSkillFile).toHaveBeenCalledWith('foo', 'scripts/build.sh', 'echo hi');
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });

  it('write_file allows empty content (an empty aux file is valid)', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    isSkillLocked.mockReturnValue(false);
    writeSkillFile.mockResolvedValue({ ok: true });
    const r = await handleAppTool('app_skill.write_file', { name: 'foo', path: 'empty.txt', content: '' });
    expect(r.ok).toBe(true);
    expect(writeSkillFile).toHaveBeenCalledWith('foo', 'empty.txt', '');
  });

  it('write_file with non-string content → ok:false, touches nothing', async () => {
    const r = await handleAppTool('app_skill.write_file', { name: 'foo', path: 'a.txt' });
    expect(r.ok).toBe(false);
    expect(getSkill).not.toHaveBeenCalled();
    expect(writeSkillFile).not.toHaveBeenCalled();
  });

  it('write_file on a missing skill → ok:false (aux files cannot bootstrap a skill)', async () => {
    getSkill.mockResolvedValue(null);
    const r = await handleAppTool('app_skill.write_file', { name: 'ghost', path: 'a.txt', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
    expect(writeSkillFile).not.toHaveBeenCalled();
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('write_file on a locked skill → ok:false, never writes (holds in bypass mode)', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    isSkillLocked.mockReturnValue(true);
    const r = await handleAppTool('app_skill.write_file', { name: 'foo', path: 'a.txt', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
    expect(writeSkillFile).not.toHaveBeenCalled();
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('write_file surfaces a store error (e.g. path guard) without firing onSkillsChanged', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    isSkillLocked.mockReturnValue(false);
    writeSkillFile.mockResolvedValue({ ok: false, error: 'Invalid or reserved skill file path: ../x' });
    const r = await handleAppTool('app_skill.write_file', { name: 'foo', path: '../x', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid or reserved/);
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('delete_file deletes + fires onSkillsChanged', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    isSkillLocked.mockReturnValue(false);
    deleteSkillFile.mockResolvedValue({ ok: true });
    const r = await handleAppTool('app_skill.delete_file', { name: 'foo', path: 'a.txt' });
    expect(r).toEqual({ ok: true, data: { name: 'foo', path: 'a.txt' } });
    expect(deleteSkillFile).toHaveBeenCalledWith('foo', 'a.txt');
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });

  it('delete_file on a locked skill → ok:false, never deletes', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    isSkillLocked.mockReturnValue(true);
    const r = await handleAppTool('app_skill.delete_file', { name: 'foo', path: 'a.txt' });
    expect(r.ok).toBe(false);
    expect(deleteSkillFile).not.toHaveBeenCalled();
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('delete_file surfaces a store error (absent file) without firing onSkillsChanged', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nb');
    isSkillLocked.mockReturnValue(false);
    deleteSkillFile.mockResolvedValue({ ok: false, error: 'file not found: a.txt' });
    const r = await handleAppTool('app_skill.delete_file', { name: 'foo', path: 'a.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file not found/);
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });
});

describe('app-tool dispatcher (write ops)', () => {
  it('app_skill.create writes content over a placeholder, returns finalName, fires onSkillsChanged', async () => {
    createSkill.mockResolvedValue({ name: 'my-skill' });
    updateSkill.mockResolvedValue({ ok: true, name: 'deploy-helper' });
    const r = await handleAppTool('app_skill.create', { content: '---\nname: deploy-helper\n---\nbody' });
    expect(r).toEqual({ ok: true, data: { name: 'deploy-helper' } });
    expect(updateSkill).toHaveBeenCalledWith('my-skill', '---\nname: deploy-helper\n---\nbody');
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
    expect(deleteSkill).not.toHaveBeenCalled();
  });

  it('app_skill.create rolls back the placeholder + no broadcast when updateSkill fails (e.g. name collision)', async () => {
    createSkill.mockResolvedValue({ name: 'my-skill' });
    updateSkill.mockResolvedValue({ ok: false, error: 'A skill named "x" already exists' });
    const r = await handleAppTool('app_skill.create', { content: '---\nname: x\n---\nb' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/);
    expect(deleteSkill).toHaveBeenCalledWith('my-skill'); // rolled back
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('app_skill.create without content → ok:false, touches nothing', async () => {
    const r = await handleAppTool('app_skill.create', {});
    expect(r.ok).toBe(false);
    expect(createSkill).not.toHaveBeenCalled();
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('app_skill.update writes by name, returns finalName, fires onSkillsChanged', async () => {
    getSkill.mockResolvedValue('---\nname: old\n---\nb'); // exists → passes the guard
    updateSkill.mockResolvedValue({ ok: true, name: 'renamed' });
    const r = await handleAppTool('app_skill.update', { name: 'old', content: '---\nname: renamed\n---\nb' });
    expect(r).toEqual({ ok: true, data: { name: 'renamed' } });
    expect(updateSkill).toHaveBeenCalledWith('old', '---\nname: renamed\n---\nb');
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });

  it('app_skill.update on a non-existent skill → ok:false, never upserts (no create)', async () => {
    getSkill.mockResolvedValue(null); // skill does not exist
    const r = await handleAppTool('app_skill.update', { name: 'does-not-exist', content: '---\nname: does-not-exist\n---\nb' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
    expect(updateSkill).not.toHaveBeenCalled(); // must not fall through to the store's upsert
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('app_skill.update on a locked skill → ok:false, never writes (holds in bypass mode)', async () => {
    getSkill.mockResolvedValue('---\nname: locked-one\n---\nb'); // exists
    isSkillLocked.mockReturnValue(true);
    const r = await handleAppTool('app_skill.update', { name: 'locked-one', content: '---\nname: locked-one\n---\nnew' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
    expect(updateSkill).not.toHaveBeenCalled();
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('app_skill.update surfaces store errors without firing onSkillsChanged', async () => {
    getSkill.mockResolvedValue('---\nname: old\n---\nb'); // exists → passes the guard
    updateSkill.mockResolvedValue({ ok: false, error: 'needs a name' });
    const r = await handleAppTool('app_skill.update', { name: 'old', content: '...' });
    expect(r.ok).toBe(false);
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });
});
