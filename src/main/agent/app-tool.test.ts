import { describe, it, expect, vi, beforeEach } from 'vitest';

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
