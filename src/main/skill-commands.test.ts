import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SKILL_COMMAND_FILE, SKILL_COMMAND_TEMP_PREFIX, type SkillCommandRegistration } from '@shared/skill-commands';

let root: string;
vi.mock('electron', () => ({ app: { getPath: () => root } }));
const { createSkillCommandStore } = await import('./skill-commands');
const { updateSkill, deleteSkill, resolveAuxPath, listSkillAuxFiles, writeSkillFile, setSkillDisabled, setSkillLocked } = await import('./skills-store');
const collection = () => path.join(root, 'skills', 'skills');
const store = () => createSkillCommandStore({ collectionDirectory: collection, reservedAliases: new Set(['model']) });
const draft = { alias: 'dev-flow', description: 'Run workflow' };
function seed(name: string) {
  const dir = path.join(collection(), name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\nbody`);
  return dir;
}
async function register(name: string): Promise<SkillCommandRegistration> {
  const result = await store().save(name, draft);
  expect(result.ok).toBe(true);
  if (!result.ok || !result.value) throw new Error('Fixture registration failed');
  return result.value;
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-command-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('source command registrations', () => {
  it('persists across store instances, retains ID when edited, renews it after unregister', async () => {
    const directory = seed('flow'); const markdown = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
    const first = await register('flow');
    expect(await store().read('flow')).toEqual({ ok: true, value: first });
    const changed = await store().save('flow', { ...draft, alias: 'workflow' });
    expect(changed).toMatchObject({ ok: true, value: { registrationId: first.registrationId, alias: 'workflow' } });
    expect(await store().save('flow', null)).toEqual({ ok: true, value: null });
    expect((await register('flow')).registrationId).not.toBe(first.registrationId);
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toBe(markdown);
  });

  it('reserves aliases for disabled skills, but lock does not block user settings', async () => {
    seed('flow'); seed('other'); await register('flow');
    await setSkillDisabled('flow', true); await setSkillLocked('other', true);
    expect(await store().save('other', draft)).toMatchObject({ ok: false, error: expect.stringMatching(/conflicts/) });
    expect(await store().save('other', { ...draft, alias: 'other' })).toMatchObject({ ok: true });
    expect(await store().catalog()).toMatchObject({ ok: true, value: [expect.objectContaining({ skillName: 'flow', disabled: true }), expect.objectContaining({ skillName: 'other' })] });
  });

  it('serializes concurrent registrations so only one claimant wins', async () => {
    seed('a'); seed('b');
    const results = await Promise.all([store().save('a', draft), store().save('b', draft)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
  });

  it('carries registration through rename and removes it with the skill', async () => {
    seed('flow'); const first = await register('flow');
    await Promise.all([updateSkill('flow', '---\nname: renamed\n---\nbody'), store().save('renamed', { ...draft, description: 'Updated' })]);
    expect(await store().read('renamed')).toMatchObject({ ok: true, value: { registrationId: first.registrationId, description: 'Updated' } });
    await deleteSkill('renamed');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store().save('renamed', draft)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(collection(), 'renamed'))).toBe(false);
  });

  it('rejects reserved/invalid inputs and leaves corruption intact until explicit unregister', async () => {
    const directory = seed('flow');
    expect(await store().save('flow', { ...draft, alias: 'model' })).toMatchObject({ ok: false });
    expect(await store().save('flow', { ...draft, alias: 'Bad' })).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(directory, SKILL_COMMAND_FILE), '{broken');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store().read('flow')).toMatchObject({ ok: false });
    expect(await store().catalog()).toMatchObject({ ok: false });
    expect(await store().save('flow', draft)).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(directory, SKILL_COMMAND_FILE), 'utf8')).toBe('{broken');
    expect(report).toHaveBeenCalled();
    expect(await store().save('flow', null)).toEqual({ ok: true, value: null });
    expect(await store().catalog()).toEqual({ ok: true, value: [] });
  });

  it('keeps prior bytes on atomic rename failure, cleans temp and releases mutation queue', async () => {
    const directory = seed('flow'); await register('flow');
    const original = fs.readFileSync(path.join(directory, SKILL_COMMAND_FILE), 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
    expect(await store().save('flow', { ...draft, alias: 'changed' })).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(directory, SKILL_COMMAND_FILE), 'utf8')).toBe(original);
    expect(fs.readdirSync(directory).filter(name => name.startsWith(SKILL_COMMAND_TEMP_PREFIX))).toEqual([]);
    rename.mockRestore();
    expect(await store().save('flow', { ...draft, alias: 'changed' })).toMatchObject({ ok: true });
  });

  it('does not follow metadata symlinks or allow aux APIs to change main-owned files', async () => {
    const directory = seed('flow'); const outside = path.join(root, 'outside'); fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(directory, SKILL_COMMAND_FILE));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store().read('flow')).toMatchObject({ ok: false });
    for (const rel of [SKILL_COMMAND_FILE, SKILL_COMMAND_FILE.toUpperCase(), `${SKILL_COMMAND_FILE}/child`, `${SKILL_COMMAND_TEMP_PREFIX}fixture`]) {
      expect(resolveAuxPath('flow', rel)).toBeNull();
      expect(await writeSkillFile('flow', rel, 'bad')).toMatchObject({ ok: false });
    }
    expect(await listSkillAuxFiles('flow')).toEqual([]);
    await store().save('flow', null);
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}');
  });
});

it('reports a disappeared/unreadable observed sidecar rather than treating it as unregistered', async () => {
  seed('flow'); await register('flow');
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file).endsWith(SKILL_COMMAND_FILE)) throw Object.assign(new Error('disappeared'), { code: 'ENOENT' });
    return (read as (...values: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
  expect(await store().read('flow')).toMatchObject({ ok: false, error: expect.stringMatching(/Cannot read/) });
});

it('runs caller authorization after earlier queued UI mutations, before writing content', async () => {
  seed('flow');
  const original = fs.readFileSync(path.join(collection(), 'flow', 'SKILL.md'), 'utf8');
  const lock = setSkillLocked('flow', true);
  const write = updateSkill('flow', '---\nname: flow\n---\nchanged', () => {
    if (fs.existsSync(path.join(collection(), 'flow', '.locked'))) throw new Error('locked');
  });
  await expect(write).rejects.toThrow('locked'); await lock;
  expect(fs.readFileSync(path.join(collection(), 'flow', 'SKILL.md'), 'utf8')).toBe(original);
});
