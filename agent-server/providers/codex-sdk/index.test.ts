import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import { createCodexOfficialBackend } from './index';
import type { LoginRpc } from '../codex-shared/app-server-login';
import type { OutgoingMessage } from '../types';
import type { Input, ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';

function fakeRpc(): LoginRpc & { fireCompleted: (success: boolean) => void } {
  const notif = new Map<string, (p: unknown) => void>();
  return {
    async request<T>(method: string): Promise<T> {
      if (method === 'initialize') return {} as T;
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    onNotification(method, handler) { notif.set(method, handler); },
    close: vi.fn(),
    fireCompleted(success: boolean) { notif.get('account/login/completed')?.({ success }); },
  };
}

interface FakeThread {
  runStreamed(input: Input, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface FakeClient {
  startThread(options?: ThreadOptions): FakeThread;
  resumeThread(id: string, options?: ThreadOptions): FakeThread;
}

function fakeClient(events: ThreadEvent[], calls: Array<Record<string, unknown>> = []): FakeClient {
  const thread: FakeThread = {
    async runStreamed(input, options) {
      calls.push({ op: 'runStreamed', input, signal: options?.signal });
      return { events: asyncEvents(events) };
    },
  };
  return {
    startThread(options) {
      calls.push({ op: 'startThread', options });
      return thread;
    },
    resumeThread(id, options) {
      calls.push({ op: 'resumeThread', id, options });
      return thread;
    },
  };
}

async function* asyncEvents(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) yield event;
}

function restoreContext(lastSdkSessionId: string) {
  return {
    sessionId: 'session-1',
    provider: CODEX_OFFICAL_PROVIDER,
    lastSdkSessionId,
    updatedAt: 1,
  };
}

describe('Codex official SDK backend lifecycle', () => {
  it('starts a new SDK thread, translates events, persists thread id, and idles once', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const backend = createCodexOfficialBackend({
      createClient: () => fakeClient([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'hello' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } },
      ], calls),
      resolveCodexPath: () => '/runtime/codex',
    });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/repo' }, (m) => out.push(m));

    expect(calls[0]).toMatchObject({ op: 'startThread', options: expect.objectContaining({ workingDirectory: '/repo' }) });
    expect(calls[1]).toMatchObject({ op: 'runStreamed', input: 'hi' });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'thread-1' } });
    expect(out).toContainEqual({ type: 'message', msgId: 'm1', msgType: 'reply', content: 'hello' });
    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
  });

  it('resumes a persisted SDK thread id and accepts the matching thread.started id', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const backend = createCodexOfficialBackend({
      createClient: () => fakeClient([{ type: 'thread.started', thread_id: 'thread-1' }], calls),
      resolveCodexPath: () => '/runtime/codex',
    });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'again', cwd: '/repo', restoreContext: restoreContext('thread-1') }, (m) => out.push(m));

    expect(calls[0]).toMatchObject({ op: 'resumeThread', id: 'thread-1' });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'thread-1' } });
  });

  it('rejects a resume id mismatch before context_patch', async () => {
    const backend = createCodexOfficialBackend({
      createClient: () => fakeClient([{ type: 'thread.started', thread_id: 'fresh-thread' }]),
      resolveCodexPath: () => '/runtime/codex',
    });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'again', cwd: '/repo', restoreContext: restoreContext('missing-thread') }, (m) => out.push(m));

    expect(out.find((m) => m.type === 'context_patch')).toBeUndefined();
    expect(out[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/resume thread mismatch/) });
    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
  });

  it('rejects image-only turns before constructing an SDK client', async () => {
    const createClient = vi.fn();
    const backend = createCodexOfficialBackend({ createClient, resolveCodexPath: () => '/runtime/codex' });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: ' ', cwd: '/repo', images: ['/tmp/a.png'] }, (m) => out.push(m));

    expect(createClient).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/requires a text prompt/) });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('applies config-edit locally without calling the SDK', async () => {
    const createClient = vi.fn();
    const backend = createCodexOfficialBackend({ createClient, resolveCodexPath: () => '/runtime/codex' });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: '', cwd: '/repo', configEdit: { key: 'model', value: 'gpt-5-codex' } }, (m) => out.push(m));

    expect(createClient).not.toHaveBeenCalled();
    expect(out.some((m) => m.type === 'capabilities' && m.currentModel === 'gpt-5-codex')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('rejects concurrent turns defensively and idles the rejected turn once', async () => {
    let release!: () => void;
    const blockedEvents = async function* (): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: 'thread-1' };
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const backend = createCodexOfficialBackend({
      createClient: () => ({
        startThread: () => ({ runStreamed: async () => ({ events: blockedEvents() }) }),
        resumeThread: () => ({ runStreamed: async () => ({ events: blockedEvents() }) }),
      }),
      resolveCodexPath: () => '/runtime/codex',
    });
    const first: OutgoingMessage[] = [];
    const second: OutgoingMessage[] = [];
    const running = backend.query({ prompt: 'first', cwd: '/repo' }, (m) => first.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backend.query({ prompt: 'second', cwd: '/repo' }, (m) => second.push(m));
    release();
    await running;

    expect(second[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/already running/) });
    expect(second.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
  });

  it('aborts the active turn on stop and still idles once', async () => {
    const backend = createCodexOfficialBackend({
      createClient: () => ({
        startThread: () => ({
          async runStreamed(_input, options) {
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: 'thread-1' };
                await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
              })(),
            };
          },
        }),
        resumeThread: () => { throw new Error('unused'); },
      }),
      resolveCodexPath: () => '/runtime/codex',
    });
    const out: OutgoingMessage[] = [];
    const running = backend.query({ prompt: 'first', cwd: '/repo' }, (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backend.stop();
    await running;

    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
  });

  it('surfaces SDK construction failures and idles once', async () => {
    const backend = createCodexOfficialBackend({
      createClient: () => { throw new Error('spawn failed'); },
      resolveCodexPath: () => '/runtime/codex',
    });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/repo' }, (m) => out.push(m));

    expect(out[0]).toEqual({ type: 'error', error: 'codex-offical: spawn failed' });
    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
  });

  it('reports the reduced SDK capability surface with current saved intent', async () => {
    const backend = createCodexOfficialBackend({
      listBundledModels: () => [
        { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', effortLevels: [{ value: 'low', displayName: 'low' }] },
      ],
    });
    const caps = await backend.gatherCapabilities!(
      '/repo',
      undefined,
      [{ id: 'custom-model' }],
      { model: 'custom-model', effort: 'minimal', permissionMode: 'plan' },
    );

    expect(caps.models.map((m) => m.value)).toEqual(['gpt-5.6-sol', 'custom-model']);
    expect(caps.effortLevels.map((e) => e.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(caps.permissionModes.map((p) => p.value)).toEqual(['default', 'plan', 'bypassPermissions']);
    expect(caps.slashCommands).toEqual([]);
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('custom-model');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('minimal');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBe('plan');
  });

  it('declares isolated config home and SDK HOME-scoped skill target', () => {
    const backend = createCodexOfficialBackend();
    expect(backend.configHome!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'));
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-sdk-home', '.agents', 'skills'));
    expect(backend.configHome!(undefined)).toBeUndefined();
    expect(backend.skillTarget!(undefined)).toBeUndefined();
  });

  it('builds full app-scoped SDK env, required shelf MCP, user MCP, and SDK skill HOME', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const backend = createCodexOfficialBackend({
      createClient: (options) => {
        calls.push({ op: 'createClient', options });
        return fakeClient([{ type: 'thread.started', thread_id: 'thread-1' }], calls);
      },
      resolveCodexPath: () => '/runtime/codex',
      getShelfMcp: async () => ({ url: 'http://127.0.0.1:9/mcp' }),
      loadMcpServers: () => ({
        servers: {
          gh: { type: 'stdio', command: 'node', args: ['server.js'], env: { GITHUB_TOKEN: 'secret-token' } },
        },
        errors: [],
      }),
    });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));

    const create = calls.find((call) => call.op === 'createClient')!;
    expect(create).toBeTruthy();
    expect(create.options).toMatchObject({
      codexPathOverride: '/runtime/codex',
      env: {
        CODEX_HOME: path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'),
        HOME: path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-sdk-home'),
        GITHUB_TOKEN: 'secret-token',
      },
      config: {
        mcp_servers: {
          shelf: { url: 'http://127.0.0.1:9/mcp', required: true },
          gh: { command: 'node', args: ['server.js'], env_vars: ['GITHUB_TOKEN'] },
        },
      },
    });
    expect(calls.find((call) => call.op === 'startThread')?.options).toMatchObject({
      additionalDirectories: [path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-sdk-home')],
    });
    expect(JSON.stringify((create.options as { config?: unknown }).config)).not.toContain('secret-token');
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('surfaces projected MCP config errors before calling the SDK', async () => {
    const createClient = vi.fn();
    const backend = createCodexOfficialBackend({
      createClient,
      resolveCodexPath: () => '/runtime/codex',
      loadMcpServers: () => ({ servers: {}, errors: ['MCP server "gh" references env var(s) not set on this host: TOKEN'] }),
    });
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));

    expect(createClient).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/MCP server "gh"/) });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('stamps auth events with the temporary provider id', async () => {
    const rpc = fakeRpc();
    const backend = createCodexOfficialBackend({ spawnLoginRpc: () => ({ rpc }) });
    const out: OutgoingMessage[] = [];
    backend.startLogin!('/repo', (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rpc.fireCompleted(true);

    expect(out[0]).toMatchObject({ type: 'auth_login_prompt', provider: CODEX_OFFICAL_PROVIDER });
    expect(out.at(-1)).toEqual({ type: 'auth_login_done', provider: CODEX_OFFICAL_PROVIDER, ok: true });
  });
});
