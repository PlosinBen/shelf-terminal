import { describe, it, expect, vi, beforeEach } from 'vitest';

const listSkills = vi.fn();
const getSkill = vi.fn();
const createSkill = vi.fn();
const updateSkill = vi.fn();
const deleteSkill = vi.fn();
const isSkillLocked = vi.fn();
vi.mock('../skills-store', () => ({
  listSkills: (...a: unknown[]) => listSkills(...a),
  getSkill: (...a: unknown[]) => getSkill(...a),
  createSkill: (...a: unknown[]) => createSkill(...a),
  updateSkill: (...a: unknown[]) => updateSkill(...a),
  deleteSkill: (...a: unknown[]) => deleteSkill(...a),
  isSkillLocked: (...a: unknown[]) => isSkillLocked(...a),
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
  onSkillsChanged.mockReset();
});

describe('app-tool dispatcher (read ops)', () => {
  it('app_skill.list → { skills } from skills-store', async () => {
    listSkills.mockResolvedValue([{ name: 'a' }, { name: 'b', description: 'B' }]);
    const r = await handleAppTool('app_skill.list');
    expect(r).toEqual({ ok: true, data: { skills: [{ name: 'a' }, { name: 'b', description: 'B' }] } });
  });

  it('app_skill.get → { name, content }', async () => {
    getSkill.mockResolvedValue('---\nname: foo\n---\nbody');
    const r = await handleAppTool('app_skill.get', { name: 'foo' });
    expect(r).toEqual({ ok: true, data: { name: 'foo', content: '---\nname: foo\n---\nbody' } });
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
    expect(isSafeAppToolOp('app_skill.create')).toBe(false); // mutation → confirm
    expect(isSafeAppToolOp('app_skill.update')).toBe(false);
    expect(isKnownAppToolOp('app_skill.create')).toBe(true);
    expect(isKnownAppToolOp('app_skill.delete')).toBe(false); // never exposed to the agent
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
