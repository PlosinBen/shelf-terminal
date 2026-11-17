import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SKILL_COMMAND_FILE } from '@shared/skill-commands';
import { SKILL_EDITOR_MAIN_FILE } from '@shared/skill-editor';
let root: string;
vi.mock('electron', () => ({ app: { getPath: () => root } }));
const { createSkillEditorService } = await import('./skills-editor');
const { createSkillCommandStore } = await import('./skill-commands');
const { skillsCollectionDir, skillDirPath, deleteSkill, setSkillLocked } = await import('./skills-store');
const service = () => createSkillEditorService(new Set(['model']));
const draft = { alias: 'dev-flow', description: 'Run workflow' };
const body = (name: string, text = 'body') => `---\nname: ${name}\ndescription: fixture\n---\n${text}`;
function seed(name: string) {
  fs.mkdirSync(skillDirPath(name), { recursive: true });
  fs.writeFileSync(path.join(skillDirPath(name), SKILL_EDITOR_MAIN_FILE), body(name));
}
const request = (name = 'flow', content = body(name)) => ({ name, activeFile: SKILL_EDITOR_MAIN_FILE, content, commandDraft: draft });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-editor-')); seed('flow'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('validates command and rename collision before writing any content', async () => {
  expect(await service().save({ ...request('flow', body('flow', 'new')), commandDraft: { ...draft, alias: '/bad' } })).toMatchObject({ ok: false, saved: { content: false, command: false } });
  seed('other');
  expect(await service().save(request('flow', body('other', 'new')))).toMatchObject({ ok: false });
  expect(fs.readFileSync(path.join(skillDirPath('flow'), SKILL_EDITOR_MAIN_FILE), 'utf8')).toBe(body('flow'));
  expect(fs.existsSync(path.join(skillDirPath('flow'), SKILL_COMMAND_FILE))).toBe(false);
});
it('allows locked user settings and avoids rewriting unchanged content', async () => {
  await setSkillLocked('flow', true);
  const write = vi.spyOn(fs.promises, 'writeFile');
  expect(await service().save(request())).toMatchObject({ ok: true, saved: { content: true, command: true }, contentChanged: false, commandChanged: true });
  expect(write).not.toHaveBeenCalled();
  const state = await service().read('flow');
  expect(state).toMatchObject({ ok: true, value: { content: body('flow'), command: { ok: true, value: draft } } });
});
it('keeps content and actual rename after metadata failure, then retries only metadata', async () => {
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('metadata denied'); });
  const first = await service().save(request('flow', body('renamed', 'new')));
  expect(first).toMatchObject({ ok: false, name: 'renamed', saved: { content: true, command: false }, contentChanged: true });
  expect(fs.existsSync(skillDirPath('flow'))).toBe(false);
  rename.mockRestore();
  const write = vi.spyOn(fs.promises, 'writeFile');
  expect(await service().save(request('renamed', body('renamed', 'new')))).toMatchObject({ ok: true, contentChanged: false, commandChanged: true });
  expect(write).not.toHaveBeenCalled();
});
it('reports the actual directory when rename succeeds but content write fails', async () => {
  vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('content denied'));
  expect(await service().save(request('flow', body('renamed', 'new')))).toMatchObject({ ok: false, name: 'renamed', saved: { content: false, command: false }, contentChanged: true });
  expect(fs.readFileSync(path.join(skillDirPath('renamed'), SKILL_EDITOR_MAIN_FILE), 'utf8')).toBe(body('flow'));
});
it('rejects alias collision before aux write and reserves control paths', async () => {
  seed('other');
  await createSkillCommandStore({ collectionDirectory: skillsCollectionDir, reservedAliases: new Set() }).save('other', draft);
  fs.writeFileSync(path.join(skillDirPath('flow'), 'reference.md'), 'old');
  expect(await service().save({ ...request(), activeFile: 'reference.md', content: 'new' })).toMatchObject({ ok: false });
  expect(fs.readFileSync(path.join(skillDirPath('flow'), 'reference.md'), 'utf8')).toBe('old');
  expect(await service().save({ ...request(), activeFile: SKILL_COMMAND_FILE, commandDraft: null })).toMatchObject({ ok: false });
});
it('explicitly removes corrupt metadata while read exposes its error', async () => {
  fs.writeFileSync(path.join(skillDirPath('flow'), SKILL_COMMAND_FILE), 'broken');
  expect(await service().read('flow')).toMatchObject({ ok: true, value: { command: { ok: false } } });
  expect(await service().save({ ...request(), commandDraft: null })).toMatchObject({ ok: true, commandChanged: true });
});
it('does not recreate a deleted stale editor target', async () => {
  await deleteSkill('flow');
  expect(await service().save(request())).toMatchObject({ ok: false });
  expect(fs.existsSync(skillDirPath('flow'))).toBe(false);
});
it('reports uncertain readback and blocks subsequent command mutation', async () => {
  const read = fs.readFileSync;
  let reads = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith(SKILL_EDITOR_MAIN_FILE) && ++reads > 1) throw new Error('readback denied');
    return read(...args);
  }) as typeof fs.readFileSync);
  expect(await service().save(request('flow', body('flow', 'new')))).toMatchObject({ ok: false, uncertain: true, saved: { command: false } });
  expect(fs.existsSync(path.join(skillDirPath('flow'), SKILL_COMMAND_FILE))).toBe(false);
});
