import fs from 'fs';
import path from 'path';
import os from 'os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createAgentInputMessage, AGENT_INPUT_SOURCE } from '@shared/agent-input';
import { SKILL_COMMAND_ERROR as E } from '@shared/skill-invocation';
import { SKILL_COMMAND_FILE } from '@shared/skill-commands';
let root: string;
vi.mock('electron', () => ({ app: { getPath: () => root } }));
const { createSkillInvocationRegistry, skillCommandCatalogRevision } = await import('./skill-invocations');
const { createSkillCommandStore } = await import('../skill-commands');
const { skillsCollectionDir: collection, skillDirPath, updateSkill, setSkillDisabled, writeSkillFile, deleteSkill } = await import('../skills-store');
let registry: ReturnType<typeof createSkillInvocationRegistry<object>>;
const owner = {};
const draft = { alias: 'dev-flow', description: 'Run flow' };
const content = (name: string, body = 'instructions') => `---\nname: ${name}\ndescription: fixture\n---\n${body}`;
const seed = (name: string) => { fs.mkdirSync(skillDirPath(name), { recursive: true }); fs.writeFileSync(path.join(skillDirPath(name), 'SKILL.md'), content(name)); };
const store = () => createSkillCommandStore({ collectionDirectory: collection, reservedAliases: new Set() });
function message(text = '/dev-flow task') {
  const result = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.TELEGRAM }, content: text });
  if (!result.ok) throw Error(result.error); return result.message;
}
async function bind() {
  const msg = message(); const invocation = (await registry.prepare(owner, msg, new Set()))!;
  registry.attach(owner, invocation, msg.msgId, 'execution');
  return { invocation, msg, request: { requestId: 'request', invocation, msgId: msg.msgId, executionId: 'execution' } };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-binding-'));
  seed('flow'); await store().save('flow', draft);
  registry = createSkillInvocationRegistry(collection);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('binds args without modifying canonical message and ignores normal/unknown/native input', async () => {
  const msg = message(); const before = JSON.stringify(msg);
  const invocation = await registry.prepare(owner, msg, new Set());
  expect(invocation).toMatchObject({ skillName: 'flow', alias: 'dev-flow', args: 'task' });
  expect(JSON.stringify(msg)).toBe(before);
  for (const text of ['normal', '/unknown', '/dev-flow\nquoted']) expect(await registry.prepare(owner, message(text), new Set())).toBeUndefined();
  expect(await registry.prepare(owner, msg, new Set(['dev-flow']))).toBeUndefined();
});
it('retains the original target when an alias is assigned to another skill', async () => {
  const bound = await bind();
  await store().save('flow', { ...draft, alias: 'new-flow' }); seed('other'); await store().save('other', draft);
  expect(await registry.validate(owner, bound.request)).toEqual({ ok: true });
  expect(bound.invocation.skillName).toBe('flow');
});
it.each(['disable', 'content', 'aux', 'rename', 'delete-recreate', 'unregister'] as const)('rejects queued target after %s', async mutation => {
  const bound = await bind();
  if (mutation === 'disable') await setSkillDisabled('flow', true);
  if (mutation === 'content') { await updateSkill('flow', content('flow', 'updated')); await updateSkill('flow', content('flow')); }
  if (mutation === 'aux') await writeSkillFile('flow', 'reference.md', 'resource');
  if (mutation === 'rename') await updateSkill('flow', content('renamed'));
  if (mutation === 'delete-recreate') { const metadata = fs.readFileSync(path.join(skillDirPath('flow'), SKILL_COMMAND_FILE)); await deleteSkill('flow'); seed('flow'); fs.writeFileSync(path.join(skillDirPath('flow'), SKILL_COMMAND_FILE), metadata); }
  if (mutation === 'unregister') { await store().save('flow', null); await store().save('flow', draft); }
  expect(await registry.validate(owner, bound.request)).toMatchObject({ ok: false });
});
it('rejects wrong owner, message, execution, and mutated binding payload', async () => {
  const bound = await bind();
  for (const [target, request] of [[{}, bound.request], [owner, { ...bound.request, msgId: 'other' }], [owner, { ...bound.request, executionId: 'other' }], [owner, { ...bound.request, invocation: { ...bound.invocation, args: 'changed' } }]] as const) expect(await registry.validate(target, request)).toMatchObject({ ok: false, code: E.CHANGED });
  expect(await registry.validate(owner, bound.request)).toEqual({ ok: true });
});
it('rejects stale selection instead of treating it as an unknown prompt', async () => {
  const catalog = await store().catalog(); if (!catalog.ok) throw Error(catalog.error);
  const hint = { registrationId: catalog.value[0].command.registrationId, catalogRevision: skillCommandCatalogRevision(catalog.value) };
  await store().save('flow', null);
  await expect(registry.prepare(owner, message(), new Set(), hint)).rejects.toMatchObject({ code: E.STALE });
});
it('rejects unreadable/symlink payloads and clears ownership on close', async () => {
  const bound = await bind(); registry.close(owner);
  expect(registry.size()).toBe(0);
  expect(await registry.validate(owner, bound.request)).toMatchObject({ ok: false });
  fs.symlinkSync(path.join(skillDirPath('flow'), 'SKILL.md'), path.join(skillDirPath('flow'), 'link.md'));
  await expect(registry.prepare(owner, message(), new Set())).rejects.toThrow('symlink');
});
