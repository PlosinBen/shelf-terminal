import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the handlers registered via ipcMain.handle so we can invoke them.
const handlers = new Map<string, (...a: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}));

const setSkillLocked = vi.fn();
const updateSkill = vi.fn();
vi.mock('../skills-store', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: (...a: unknown[]) => updateSkill(...a),
  deleteSkill: vi.fn(),
  setSkillLocked: (...a: unknown[]) => setSkillLocked(...a),
  listSkillAuxFiles: vi.fn(),
  readSkillFile: vi.fn(),
  writeSkillFile: vi.fn(),
  deleteSkillFile: vi.fn(),
}));

const onSkillsChanged = vi.fn();
const notifyRendererSkillsChanged = vi.fn();
vi.mock('../skills-sync', () => ({
  onSkillsChanged: () => onSkillsChanged(),
  notifyRendererSkillsChanged: () => notifyRendererSkillsChanged(),
}));

const { registerSkillsHandlers } = await import('./skills');
const { IPC } = await import('@shared/ipc-channels');

beforeEach(() => {
  handlers.clear();
  setSkillLocked.mockReset();
  updateSkill.mockReset();
  onSkillsChanged.mockReset();
  notifyRendererSkillsChanged.mockReset();
  registerSkillsHandlers();
});

describe('SKILLS_SET_LOCKED handler', () => {
  // Lock/unlock is metadata-only: it must NOT run the full reload pipeline
  // (re-project + remote re-sync + session hot-reload), which would inject a
  // stray "Skills reloaded" line into unrelated live agent tabs. It only
  // repaints the renderer badge.
  it('sets the lock and ONLY notifies the renderer — no onSkillsChanged', async () => {
    await handlers.get(IPC.SKILLS_SET_LOCKED)!({}, { name: 'a', locked: true });
    expect(setSkillLocked).toHaveBeenCalledWith('a', true);
    expect(notifyRendererSkillsChanged).toHaveBeenCalledTimes(1);
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it('unlock takes the same renderer-only path', async () => {
    await handlers.get(IPC.SKILLS_SET_LOCKED)!({}, { name: 'a', locked: false });
    expect(setSkillLocked).toHaveBeenCalledWith('a', false);
    expect(notifyRendererSkillsChanged).toHaveBeenCalledTimes(1);
    expect(onSkillsChanged).not.toHaveBeenCalled();
  });
});

describe('content mutations still run the full pipeline', () => {
  it('SKILLS_UPDATE fires onSkillsChanged on success', async () => {
    updateSkill.mockResolvedValue({ ok: true, name: 'a' });
    await handlers.get(IPC.SKILLS_UPDATE)!({}, { name: 'a', content: 'x' });
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });
});
