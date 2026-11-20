import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../types';
import { AGENT_INPUT_SOURCE, AGENT_REPLY_REQUIREMENT, createAgentInputMessage } from '@shared/agent-input';
const modelInputs: any[] = [];
const sdkMessages: any[] = [];
let sdkModels: Array<{ value: string; displayName: string }> = [];

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
  modelInputs.length = 0;
  sdkMessages.length = 0;
  sdkModels = [];
  sessions.length = 0;
  sdk.query.mockImplementation(({ prompt, options }) => {
    async function* messages() {
      if (typeof prompt === 'string') { yield { type: 'system', subtype: 'init', session_id: 'probe' }; return; }
      for await (const _user of prompt) {
        modelInputs.push(_user);
        yield { type: 'system', subtype: 'init', session_id: 'live-session' };
        yield* sdkMessages.splice(0);
        yield { type: 'result', subtype: 'success', session_id: 'live-session' };
      }
    }
    const query = Object.assign(messages(), {
      supportedModels: async () => sdkModels, supportedCommands: async () => [], mcpServerStatus: async () => [],
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

it('confirms direct controls without timeline or execution side effects, including same-value no-op', async () => {
  await warm();
  const out: OutgoingMessage[] = [];
  expect(backend.configRequiresIdle!('model')).toBe(false);
  expect(backend.configRequiresIdle!('effort')).toBe(true);
  for (const value of ['new', 'new']) await backend.configure!({ key: 'model', value }, m => out.push(m));
  expect(out).toHaveLength(2);
  expect(out.every(m => m.type === 'capabilities')).toBe(true);
  expect(sessions[0].setModel).toHaveBeenCalledTimes(1);
});

it('does not interrupt running background tasks for effort, but permits it after task completion', async () => {
  sdkMessages.push({ type: 'system', subtype: 'task_started', task_id: 'config-task', description: 'Background work', task_type: 'local_bash', tool_use_id: 'config-tool' });
  await warm();
  await expect(backend.configure!({ key: 'effort', value: 'high' }, () => {})).rejects.toThrow('background work');
  expect(sessions[0].close).not.toHaveBeenCalled();
  sdkMessages.push({ type: 'system', subtype: 'task_notification', task_id: 'config-task', status: 'completed', summary: 'Done' });
  await backend.query({ prompt: 'observe completed task', cwd: '/tmp' }, () => {});
  await expect(backend.configure!({ key: 'effort', value: 'high' }, () => {})).resolves.toBeUndefined();
});

it('does not let a running response model overwrite a newer direct selection', async () => {
  sdkModels = [{ value: 'recommended', displayName: 'Recommended' }];
  await backend.gatherCapabilities!('/tmp', undefined, undefined, { model: 'old-custom' });
  let release!: (message: any) => void;
  sdkMessages.push(new Promise(resolve => { release = resolve; }));
  const out: OutgoingMessage[] = [];
  const run = backend.query({ prompt: 'running work', cwd: '/tmp' }, m => out.push(m));
  await vi.waitFor(() => expect(sessions).toHaveLength(1));
  await backend.configure!({ key: 'model', value: 'new-custom' }, m => out.push(m));
  release({ type: 'assistant', message: { model: 'old-resolved', content: [] } });
  await run;
  expect(out.filter(m => m.type === 'capabilities').at(-1)).toMatchObject({ currentModel: 'new-custom' });
});

it('applies common reply guidance only to the model input, not config slashes', async () => {
  const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.TELEGRAM }, content: 'original', replyRequirement: AGENT_REPLY_REQUIREMENT.BRIEF_PLAIN_TEXT });
  if (!built.ok) throw new Error(built.error);
  await backend.query({ prompt: built.message.content, inputMessage: built.message, cwd: '/tmp' }, () => {});
  expect(modelInputs.at(-1).message.content).toContain('original\n\n[System note:');
  expect(built.message.content).toBe('original');
  const count = modelInputs.length;
  await backend.query({ prompt: '  /model new  ', inputMessage: { ...built.message, content: '  /model new  ' }, cwd: '/tmp' }, () => {});
  expect(sessions[0].setModel).toHaveBeenCalledWith('new');
  expect(modelInputs).toHaveLength(count);
});

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


it('forwards restrictive permission hints and rejects a forbidden session grant', async () => {
  const out: OutgoingMessage[] = [];
  await backend.query({ prompt: 'first', cwd: '/tmp' }, m => out.push(m));
  const answer = sessions[0].options.canUseTool('Write', {}, {
    toolUseID: 'restricted', defaultToNo: true, suppressAlwaysAllowRule: true,
  });
  expect(out.at(-1)).toMatchObject({
    type: 'permission_request', constraints: { defaultToDeny: true, allowSession: false },
  });
  backend.resolvePermission!('restricted', true, undefined, 'session');
  await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
});

it('allows an explicit once grant under restrictive hints', async () => {
  await warm();
  const answer = sessions[0].options.canUseTool('Write', {}, {
    toolUseID: 'once', defaultToNo: true, suppressAlwaysAllowRule: true,
  });
  backend.resolvePermission!('once', true, undefined, 'once');
  await expect(answer).resolves.toEqual({ behavior: 'allow', updatedInput: {} });
});


it('retains session approval when the SDK does not forbid it', async () => {
  await warm();
  const answer = sessions[0].options.canUseTool('Write', {}, { toolUseID: 'session' });
  backend.resolvePermission!('session', true, undefined, 'session');
  await expect(answer).resolves.toMatchObject({ behavior: 'allow', updatedPermissions: [
    { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Write' }] },
  ] });
});
