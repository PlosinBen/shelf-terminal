import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../types';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdk.query, tool: () => ({}), createSdkMcpServer: () => ({}),
}));
vi.mock('./auth-status', () => ({
  CLAUDE_CLI_AUTH_OUTCOME: { AUTHENTICATED: 'authenticated', UNAUTHENTICATED: 'unauthenticated', UNKNOWN: 'unknown' },
  probeClaudeCliAuth: async () => ({ outcome: 'authenticated' }),
}));
import { createClaudeBackend } from './index';

let backend: ReturnType<typeof createClaudeBackend>;
const sessions: Array<{ options: any; setModel: ReturnType<typeof vi.fn>; setPermissionMode: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  sessions.length = 0;
  sdk.query.mockImplementation(({ prompt, options }) => {
    async function* messages() {
      if (typeof prompt === 'string') { yield { type: 'system', subtype: 'init', session_id: 'probe' }; return; }
      for await (const _user of prompt) {
        yield { type: 'system', subtype: 'init', session_id: 'live-session' };
        yield { type: 'result', subtype: 'success', session_id: 'live-session' };
      }
    }
    const query = Object.assign(messages(), {
      supportedModels: async () => [], supportedCommands: async () => [], mcpServerStatus: async () => [],
      setModel: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}), close: vi.fn(),
    });
    if (typeof prompt !== 'string') sessions.push({ options, ...query });
    return query;
  });
  backend = createClaudeBackend();
});
afterEach(() => backend.dispose());

async function warm() {
  await backend.gatherCapabilities!('/tmp', undefined, undefined, { model: 'old', effort: 'low', permissionMode: 'default' });
  await backend.query({ prompt: 'first', cwd: '/tmp' }, () => {});
}

it('applies live model edits to the SDK before reporting success', async () => {
  await warm();
  let release!: () => void;
  sessions[0].setModel.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const out: OutgoingMessage[] = [];
  const edit = backend.query({ prompt: '', cwd: '/tmp', configEdit: { key: 'model', value: 'new' } }, m => out.push(m));
  await vi.waitFor(() => expect(sessions[0].setModel).toHaveBeenCalledWith('new'));
  expect(out.some(m => m.type === 'capabilities')).toBe(false);
  release();
  await edit;
  expect(out).toContainEqual(expect.objectContaining({ type: 'capabilities', currentModel: 'new' }));
});

it('does not report or save rejected model edits', async () => {
  await warm();
  sessions[0].setModel.mockRejectedValueOnce(new Error('model rejected'));
  const out: OutgoingMessage[] = [];
  await expect(backend.query({ prompt: '/model new', cwd: '/tmp' }, m => out.push(m))).rejects.toThrow('model rejected');
  expect(out.some(m => m.type === 'capabilities')).toBe(false);
  const caps = await backend.gatherCapabilities!('/tmp');
  expect(caps.currentModel).toBe('old');
});

it('rebuilds the live session with the new effort and preserves resume', async () => {
  await warm();
  await backend.query({ prompt: '/effort high', cwd: '/tmp' }, () => {});
  await backend.query({ prompt: 'next', cwd: '/tmp' }, () => {});
  expect(sessions).toHaveLength(2);
  expect(sessions[0].close).toHaveBeenCalledTimes(1);
  expect(sessions[1].options).toMatchObject({ effort: 'high', model: 'old', resume: 'live-session' });
});

it('applies live permission edits and seeds bypass behavior without per-message prefs', async () => {
  await warm();
  await backend.query({ prompt: '', cwd: '/tmp', configEdit: { key: 'permissionMode', value: 'plan' } }, () => {});
  expect(sessions[0].setPermissionMode).toHaveBeenCalledWith('plan');
  await backend.query({ prompt: '/permission bypassPermissions', cwd: '/tmp' }, () => {});
  expect(sessions[0].setPermissionMode).toHaveBeenLastCalledWith('default');
  await expect(sessions[0].options.canUseTool('Read', {}, { toolUseID: 'read' })).resolves.toMatchObject({ behavior: 'allow' });
});

it('initializes bypass before creating the first SDK session', async () => {
  await backend.gatherCapabilities!('/tmp', undefined, undefined, { permissionMode: 'bypassPermissions' });
  await backend.query({ prompt: 'first', cwd: '/tmp' }, () => {});
  expect(sessions[0].options.permissionMode).toBe('default');
  await expect(sessions[0].options.canUseTool('Read', {}, { toolUseID: 'read' })).resolves.toMatchObject({ behavior: 'allow' });
});
