import { describe, it, expect, vi, beforeEach } from 'vitest';

const listSkills = vi.fn();
const getSkill = vi.fn();
vi.mock('../skills-store', () => ({
  listSkills: (...a: unknown[]) => listSkills(...a),
  getSkill: (...a: unknown[]) => getSkill(...a),
}));

import { handleAppTool, isSafeAppToolOp, isKnownAppToolOp } from './app-tool';

beforeEach(() => {
  listSkills.mockReset();
  getSkill.mockReset();
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

  it('registry flags: reads are safe; unknown ops are neither known nor safe', () => {
    expect(isSafeAppToolOp('app_skill.list')).toBe(true);
    expect(isSafeAppToolOp('app_skill.get')).toBe(true);
    expect(isKnownAppToolOp('app_skill.list')).toBe(true);
    expect(isKnownAppToolOp('app_skill.create')).toBe(false); // not shipped yet
    expect(isSafeAppToolOp('app_skill.create')).toBe(false);
  });
});
