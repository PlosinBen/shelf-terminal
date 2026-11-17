import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the handlers registered via ipcMain.handle so we can invoke them.
const handlers = new Map<string, (...a: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}));

const setSkillLocked = vi.fn();
const setSkillDisabled = vi.fn();
const updateSkill = vi.fn();
vi.mock('../skills-store', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: (...a: unknown[]) => updateSkill(...a),
  deleteSkill: vi.fn(),
  setSkillLocked: (...a: unknown[]) => setSkillLocked(...a),
  setSkillDisabled: (...a: unknown[]) => setSkillDisabled(...a),
  listSkillAuxFiles: vi.fn(),
  readSkillFile: vi.fn(),
  writeSkillFile: vi.fn(),
  deleteSkillFile: vi.fn(),
}));

const editorRead = vi.fn();
const editorSave = vi.fn();
vi.mock('../skills-editor', () => ({
  createSkillEditorService: () => ({ read: (...args: unknown[]) => editorRead(...args), save: (...args: unknown[]) => editorSave(...args) }),
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
  editorRead.mockReset();
  editorSave.mockReset();
  setSkillLocked.mockReset();
  setSkillDisabled.mockReset();
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

describe('SKILLS_SET_DISABLED handler', () => {
  // Disabling changes the projected/synced tree (the skill's folder is dropped),
  // so — UNLIKE lock — it MUST run the full onSkillsChanged() pipeline (re-project
  // + remote re-sync + hot-reload), not the badge-only renderer notify.
  it('sets the marker and runs the full onSkillsChanged pipeline', async () => {
    await handlers.get(IPC.SKILLS_SET_DISABLED)!({}, { name: 'a', disabled: true });
    expect(setSkillDisabled).toHaveBeenCalledWith('a', true);
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });

  it('re-enabling takes the same full-pipeline path', async () => {
    await handlers.get(IPC.SKILLS_SET_DISABLED)!({}, { name: 'a', disabled: false });
    expect(setSkillDisabled).toHaveBeenCalledWith('a', false);
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });
});

describe('content mutations still run the full pipeline', () => {
  it('SKILLS_UPDATE fires onSkillsChanged on success', async () => {
    updateSkill.mockResolvedValue({ ok: true, name: 'a' });
    await handlers.get(IPC.SKILLS_UPDATE)!({}, { name: 'a', content: 'x' });
    expect(onSkillsChanged).toHaveBeenCalledTimes(1);
  });
});


describe('editor coordinator handlers', () => {
  it('returns read state including metadata errors', async () => {
    const state = { ok: true, value: { content: 'body', command: { ok: false, error: 'invalid metadata' } } };
    editorRead.mockResolvedValue(state);
    expect(await handlers.get(IPC.SKILLS_EDITOR_READ)!({}, 'flow')).toEqual(state);
    expect(editorRead).toHaveBeenCalledWith('flow');
  });
  it.each([
    [true, false, false, 1, 0],
    [false, true, true, 0, 1],
    [false, false, false, 0, 0],
  ])('notifies for actual mutations even on partial failure (%s/%s)', async (contentChanged, commandChanged, ok, full, renderer) => {
    const result = { ok, name: 'flow', saved: { content: true, command: ok }, contentChanged, commandChanged };
    editorSave.mockResolvedValue(result);
    const request = { name: 'flow', activeFile: 'SKILL.md', content: 'body', commandDraft: null };
    expect(await handlers.get(IPC.SKILLS_EDITOR_SAVE)!({}, request)).toEqual(result);
    expect(editorSave).toHaveBeenCalledWith(request);
    expect(onSkillsChanged).toHaveBeenCalledTimes(full);
    expect(notifyRendererSkillsChanged).toHaveBeenCalledTimes(renderer);
  });
});
