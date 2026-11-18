import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { skillPayloadDigest } from '@shared/skill-payload';
import { SKILL_INVOCATION, type SkillInvocation } from '@shared/skill-invocation';
import { createMockAcpAgent } from '../acp/mock-agent';
const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../shared', async original => ({ ...await original<typeof import('../shared')>(), resolveSkillsPluginRoot: () => fixture.root }));
import { createCopilotBackend } from './index';
let backend: ReturnType<typeof createCopilotBackend>;
let invocation: SkillInvocation;
let catalog: Array<{ name: string; path: string; source: string; enabled: boolean }>;
let readCatalog: ReturnType<typeof vi.fn<(cwd: string, appId?: string) => Promise<typeof catalog>>>;
let prompts: any[];
beforeEach(() => {
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-command-')));
  const directory = path.join(fixture.root, 'skills', 'flow');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: flow\ndescription: workflow\n---\nAPP');
  invocation = { kind: SKILL_INVOCATION.KIND, bindingId: randomUUID(), registrationId: randomUUID(), skillName: 'flow', alias: 'dev-flow', args: 'task', payloadDigest: skillPayloadDigest(directory) };
  catalog = [{ name: 'flow', path: directory, source: 'personal-copilot', enabled: true }];
  readCatalog = vi.fn<(cwd: string, appId?: string) => Promise<typeof catalog>>(async () => catalog.map(row => ({ ...row })));
  prompts = [];
  const agent = createMockAcpAgent({ commandsOnNewSession: [{ name: 'flow', description: 'flow' }], onPrompt: prompt => prompts.push(prompt) });
  backend = createCopilotBackend({ openAgent: () => ({ target: agent }), getShelfMcp: async () => null, readSkillCatalog: readCatalog });
});
afterEach(() => { backend.dispose(); fs.rmSync(fixture.root, { recursive: true, force: true }); });
async function warm(restoreContext?: any) { return backend.gatherCapabilities!(fixture.root, undefined, undefined, undefined, undefined, 'app', restoreContext); }
async function invoke(extra: Record<string, unknown> = {}) {
  const out: any[] = [];
  await backend.query({ prompt: '/dev-flow task', cwd: fixture.root, appId: 'app', invocation, ...extra }, m => out.push(m));
  return out;
}
it('keeps commands available and dispatches verified text and empty arguments natively', async () => {
  expect(await warm()).toMatchObject({ appSkillCommands: { available: true } });
  expect(await invoke()).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  expect(prompts[0].prompt).toEqual([{ type: 'text', text: '/flow task' }]);
  invocation.args = '';
  await invoke();
  expect(prompts[1].prompt).toEqual([{ type: 'text', text: '/flow' }]);
});
it.each([
  { images: ['data:image/png;base64,aGVsbG8='] },
  { attachments: [{ kind: 'image', path: '/image.png', name: 'image.png', displayPath: '/image.png' }] },
  { attachments: [{ kind: 'file', path: '/file.txt', name: 'file.txt', displayPath: '/file.txt' }] },
])('rejects only custom command attachments before ACP dispatch: %j', async extra => {
  await warm();
  const out = await invoke(extra);
  expect(out).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('unsupported_attachments') }));
  expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  expect(prompts).toEqual([]);
  await backend.query({ prompt: 'ordinary message', cwd: fixture.root, appId: 'app', images: ['data:image/png;base64,aGVsbG8='] }, () => {});
  expect(prompts).toHaveLength(1);
  expect(prompts[0].prompt.some((block: any) => block.type === 'image')).toBe(true);
});
it('rejects a same-name project target instead of forwarding the app alias', async () => {
  await warm();
  const directory = path.join(fixture.root, 'project-shadow'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'PROJECT');
  catalog[0].path = directory; catalog[0].source = 'project';
  expect(await invoke()).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('command_conflict') }));
  expect(prompts).toEqual([]);
});
it('rejects content changed after session creation even when the new receipt matches disk', async () => {
  await warm();
  const directory = path.join(fixture.root, 'skills', 'flow');
  fs.appendFileSync(path.join(directory, 'SKILL.md'), 'UPDATED'); invocation.payloadDigest = skillPayloadDigest(directory);
  expect(await invoke()).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('target_changed') }));
  expect(prompts).toEqual([]);
});
it('does not treat disk enumeration as proof of an older resumed session snapshot', async () => {
  await warm({ lastSdkSessionId: 'restored' });
  expect(await invoke()).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('native_unavailable') }));
  expect(prompts).toEqual([]);
});
it('fails only the command when source enumeration fails', async () => {
  readCatalog.mockRejectedValue(new Error('catalog unavailable'));
  await warm();
  expect(await invoke()).toContainEqual(expect.objectContaining({ type: 'error' }));
  await backend.query({ prompt: 'ordinary message', cwd: fixture.root, appId: 'app' }, () => {});
  expect(prompts).toHaveLength(1);
});
it('rejects attachment-bearing native skill slashes that bypass app binding precedence', async () => {
  await warm();
  const out: any[] = [];
  await backend.query({ prompt: '/flow task', cwd: fixture.root, appId: 'app', images: ['data:image/png;base64,aGVsbG8='] }, m => out.push(m));
  expect(prompts).toEqual([]);
  expect(out).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('unsupported_attachments') }));
});

it('does not dispatch after stop while native source verification is pending', async () => {
  await warm();
  let release!: () => void;
  readCatalog.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(catalog.map(row => ({ ...row }))); }));
  const pending = invoke();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await backend.stop(); release();
  expect(await pending).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('stale_selection') }));
  expect(prompts).toEqual([]);
});
