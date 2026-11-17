import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { skillPayloadDigest } from '@shared/skill-payload';
import { SKILL_INVOCATION, type SkillInvocation } from '@shared/skill-invocation';
const sdk = vi.hoisted(() => ({ query: vi.fn(), root: '' }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query, tool: () => ({}), createSdkMcpServer: () => ({}) }));
vi.mock('../shared', async original => ({ ...await original<typeof import('../shared')>(), resolveSkillsPluginRoot: () => sdk.root }));
import { createClaudeBackend } from './index';
let backend: ReturnType<typeof createClaudeBackend>;
let invocation: SkillInvocation;
let reload: ReturnType<typeof vi.fn>;
let inputs: any[];
beforeEach(() => {
  sdk.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-command-')));
  fs.mkdirSync(path.join(sdk.root, '.claude-plugin'));
  fs.writeFileSync(path.join(sdk.root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'shelf-skills' }));
  fs.mkdirSync(path.join(sdk.root, 'skills', 'flow'), { recursive: true });
  fs.writeFileSync(path.join(sdk.root, 'skills', 'flow', 'SKILL.md'), '---\nname: flow\ndescription: workflow\n---\nfixture');
  invocation = { kind: SKILL_INVOCATION.KIND, bindingId: randomUUID(), registrationId: randomUUID(), skillName: 'flow', alias: 'dev-flow', args: 'task', payloadDigest: skillPayloadDigest(path.join(sdk.root, 'skills', 'flow')) };
  reload = vi.fn(async () => ({ commands: [{ name: 'flow' }], plugins: [{ name: 'shelf-skills', path: sdk.root }], error_count: 0, mcpServers: [] }));
  inputs = [];
  sdk.query.mockImplementation(({ prompt }) => {
    async function* messages() {
      for await (const user of prompt) {
        inputs.push(user.message.content);
        yield { type: 'system', subtype: 'init', session_id: 'live' };
        yield { type: 'result', subtype: 'success', session_id: 'live' };
      }
    }
    return Object.assign(messages(), { reloadPlugins: reload, supportedCommands: async () => [{ name: 'flow' }], mcpServerStatus: async () => [], close: vi.fn(), interrupt: vi.fn() });
  });
  backend = createClaudeBackend();
});
afterEach(() => { backend.dispose(); fs.rmSync(sdk.root, { recursive: true, force: true }); });
async function invoke(extra: Record<string, unknown> = {}) {
  const out: any[] = [];
  await backend.query({ prompt: '/dev-flow task', cwd: sdk.root, appId: 'app', invocation, ...extra }, m => out.push(m));
  return out;
}
it('reloads the actual plugin before sending a namespaced command, retaining empty args and images', async () => {
  await invoke();
  expect(inputs).toEqual(['/shelf-skills:flow task']);
  invocation.args = '';
  await invoke({ images: ['data:image/png;base64,aGVsbG8='] });
  expect(inputs[1]).toEqual([expect.objectContaining({ type: 'image' }), { type: 'text', text: '/shelf-skills:flow' }]);
  expect(reload).toHaveBeenCalledTimes(2);
});
it('rejects an ambiguous plugin namespace without forwarding an alias', async () => {
  reload.mockResolvedValueOnce({ commands: [{ name: 'flow' }], plugins: [{ name: 'shelf-skills', path: sdk.root }, { name: 'shelf-skills', path: '/other' }], error_count: 0, mcpServers: [] });
  const out = await invoke();
  expect(inputs).toEqual([]);
  expect(out).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('source_unverified') }));
  expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
});
it('rejects projection drift during reload', async () => {
  reload.mockImplementationOnce(async () => {
    fs.writeFileSync(path.join(sdk.root, 'skills', 'flow', 'SKILL.md'), 'changed');
    return { commands: [{ name: 'flow' }], plugins: [{ name: 'shelf-skills', path: sdk.root }], error_count: 0, mcpServers: [] };
  });
  const out = await invoke();
  expect(inputs).toEqual([]);
  expect(out).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('projection_mismatch') }));
});
it('rejects a missing live command or failed reload without dispatch', async () => {
  reload.mockResolvedValueOnce({ commands: [], plugins: [{ name: 'shelf-skills', path: sdk.root }], error_count: 0, mcpServers: [] });
  const out = await invoke();
  expect(out).toContainEqual(expect.objectContaining({ type: 'error' }));
  reload.mockRejectedValueOnce(new Error('reload failed'));
  expect(await invoke()).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('reload failed') }));
  expect(inputs).toEqual([]);
});
it('does not dispatch a pending invocation after stop', async () => {
  let release!: () => void;
  reload.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ commands: [{ name: 'flow' }], plugins: [{ name: 'shelf-skills', path: sdk.root }], error_count: 0, mcpServers: [] }); }));
  const pending = invoke();
  await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  await backend.stop();
  release();
  expect(await pending).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect(inputs).toEqual([]);
});
it('rejects a project command that shadows the fully qualified plugin command', async () => {
  reload.mockResolvedValueOnce({ commands: [{ name: 'flow' }, { name: 'shelf-skills:flow' }], plugins: [{ name: 'shelf-skills', path: sdk.root }], error_count: 0, mcpServers: [] });
  const out = await invoke();
  expect(inputs).toEqual([]);
  expect(out).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('command_conflict') }));
});
