import { beforeEach, expect, it } from 'vitest';
import { loadSkillCommandDraft, resetSkillCommandDraft, editSkillCommandDraft, peekSkillCommandDraft, isSkillCommandDirty, markSkillCommandSaved } from './skillCommandDraftStore';
beforeEach(resetSkillCommandDraft);
it('keeps corrupted metadata protected until the user explicitly unregisters it', () => {
  loadSkillCommandDraft({ ok: false, error: 'Invalid JSON' }, 'flow', 'Run flow');
  expect(isSkillCommandDirty()).toBe(false);
  editSkillCommandDraft({ enabled: false });
  expect(peekSkillCommandDraft()).toBe(null);
  expect(isSkillCommandDirty()).toBe(true);
  markSkillCommandSaved(null);
  expect(isSkillCommandDirty()).toBe(false);
});
it('tracks metadata-only edits and normalizes a confirmed saved baseline', () => {
  loadSkillCommandDraft({ ok: true, value: null }, 'flow', 'Run flow');
  editSkillCommandDraft({ enabled: true, alias: ' dev-flow ', description: ' Run workflow ' });
  expect(isSkillCommandDirty()).toBe(true);
  markSkillCommandSaved(peekSkillCommandDraft());
  expect(peekSkillCommandDraft()).toEqual({ alias: 'dev-flow', description: 'Run workflow' });
  expect(isSkillCommandDirty()).toBe(false);
  editSkillCommandDraft({ description: 'Updated workflow' });
  expect(isSkillCommandDirty()).toBe(true);
});
