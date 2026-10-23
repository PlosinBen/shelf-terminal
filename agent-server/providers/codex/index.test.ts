import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_PROVIDER } from '@shared/agent-providers';
import { CODEX_AUTH_DISPLAY_NAME } from '../codex-shared/auth';
import { createCodexBackend } from './index';
import type { LoginRpc } from '../codex-shared/app-server-login';
import type { OutgoingMessage } from '../types';
import { setLogSink, type ServerLogMessage } from '../../server-logger';

interface RequestCall {
  method: string;
  params?: unknown;
}

function turnCompleted(
  id: string,
  status = 'completed',
  error: Record<string, unknown> | null = null,
  durationMs = 12,
) {
  return {
    threadId: 'thread-1',
    turn: { id, status, error, durationMs },
  };
}

class FakeAppServer {
  calls: RequestCall[] = [];
  closed = false;
  settings: Record<string, any> = { model: 'gpt-5.6-sol', effort: null, approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, activePermissionProfile: { id: ':workspace' }, collaborationMode: { mode: 'default' } };
  private notifications = new Map<string, (params: unknown) => void>();
  private requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  private handlers = new Map<string, (params?: unknown) => unknown | Promise<unknown>>();

  constructor(handlers: Record<string, (params?: unknown) => unknown | Promise<unknown>> = {}) {
    for (const [method, handler] of Object.entries(handlers)) this.handlers.set(method, handler);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler) return await handler(params) as T;
    if (method === 'initialize') return {} as T;
    if (method === 'thread/start' || method === 'thread/resume') {
      const p = params as Record<string, any>;
      this.settings.model = p.model ?? this.settings.model;
      this.settings.approvalPolicy = p.approvalPolicy ?? this.settings.approvalPolicy;
      if (p.permissions) this.settings.activePermissionProfile = { id: p.permissions };
      return { ...this.settings, reasoningEffort: this.settings.effort, sandbox: this.settings.sandboxPolicy, thread: { id: p.threadId ?? 'thread-1' } } as T;
    }
    if (method === 'permissionProfile/list') return { data: [':workspace', ':read-only', ':danger-full-access'].map(id => ({ id, allowed: true })), nextCursor: null } as T;
    if (method === 'collaborationMode/list') return { data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }] } as T;
    if (method === 'configRequirements/read') return { requirements: null } as T;
    if (method === 'thread/settings/update') {
      const p = params as Record<string, any>;
      const before = JSON.stringify(this.settings);
      for (const key of ['model', 'effort', 'approvalPolicy', 'collaborationMode']) if (p[key] !== undefined) this.settings[key] = p[key];
      if (p.permissions) this.settings.activePermissionProfile = { id: p.permissions };
      if (before !== JSON.stringify(this.settings)) this.fire('thread/settings/updated', { threadId: p.threadId, threadSettings: { ...this.settings } });
      return {} as T;
    }
    if (method === 'turn/start') {
      this.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
      this.fire('item/agentMessage/delta', { itemId: 'm1', delta: 'hel' });
      this.fire('item/agentMessage/delta', { itemId: 'm1', delta: 'lo' });
      this.fire('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'hello' } });
      this.fire('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 129_200 }, last: { inputTokens: 129_000, totalTokens: 129_200 }, modelContextWindow: 258_400 } });
      this.fire('turn/completed', turnCompleted('turn-1'));
      return { turn: { id: 'turn-1' } } as T;
    }
    if (method === 'model/list') {
      return {
        data: [
          {
            id: 'model-1',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'ultra', description: '' }],
          },
        ],
        nextCursor: null,
      } as T;
    }
    if (method === 'account/read') {
      return {
        account: { type: 'chatgpt', planType: 'plus' },
        requiresOpenaiAuth: true,
      } as T;
    }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'shelf', authStatus: 'authorized' }], nextCursor: null } as T;
    if (method === 'skills/list') return { data: [{ cwd: '/repo', skills: [{ name: 'skill-a', shortDescription: 'does A' }], errors: [] }] } as T;
    if (method === 'account/rateLimits/read') {
      return { rateLimitsByLimitId: { codex: { primary: { usedPercent: 7, resetsAt: Date.now() + 604_800_000 } } } } as T;
    }
    if (method === 'account/usage/read') return { totalTokens: 12345, requests: 9 } as T;
    if (method === 'gitDiffToRemote') return { diff: 'diff --git a/a.ts b/a.ts\n+hello' } as T;
    if (method === 'thread/goal/get') return { goal: { objective: 'ship it', status: 'in_progress', tokenBudget: 5000 } } as T;
    if (method === 'thread/goal/set') return {} as T;
    if (method === 'thread/goal/clear') return {} as T;
    if (method === 'thread/name/set') return {} as T;
    if (method === 'account/logout') return {} as T;
    if (method === 'review/start') {
      this.fire('item/completed', { item: { id: 'review-1', type: 'agentMessage', text: 'reviewed' } });
      this.fire('turn/completed', turnCompleted('review-turn'));
      return { turn: { id: 'review-turn' } } as T;
    }
    if (method === 'thread/compact/start') {
      this.fire('item/completed', { item: { id: 'compact-1', type: 'contextCompaction' } });
      this.fire('turn/completed', turnCompleted('compact-turn'));
      return { turn: { id: 'compact-turn' } } as T;
    }
    if (method === 'turn/interrupt') {
      this.fire('turn/completed', turnCompleted('turn-1', 'interrupted'));
      return {} as T;
    }
    throw new Error(`unexpected method ${method}`);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notifications.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  async serverRequest(method: string, params: unknown): Promise<unknown> {
    const handler = this.requestHandlers.get(method);
    if (!handler) throw new Error(`missing request handler ${method}`);
    return await handler(params);
  }

  fire(method: string, params: unknown): void {
    this.notifications.get(method)?.(params);
  }

  close(): void {
    this.closed = true;
  }
}

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

function restoreContext(lastSdkSessionId: string) {
  return {
    sessionId: 'session-1',
    provider: CODEX_PROVIDER,
    lastSdkSessionId,
    updatedAt: 1,
  };
}

describe('Codex official app-server backend lifecycle', () => {
  let serverLogs: ServerLogMessage[];

  beforeEach(() => {
    serverLogs = [];
    setLogSink((message) => serverLogs.push(message));
  });

  it('starts a new app-server thread, starts a turn, streams deltas, persists thread id, reports ctx, and idles once', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'hi', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(app.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ cwd: '/repo', sessionStartSource: 'startup' });
    expect(app.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'thread-1' } });
    expect(out).toContainEqual({ type: 'stream', msgId: 'm1', streamType: 'text', content: 'hel' });
    expect(out).toContainEqual({ type: 'message', msgId: 'm1', msgType: 'reply', content: 'hello' });
    expect(out).toContainEqual({ type: 'status', state: 'streaming', contextUsage: { text: 'ctx: 50%', severity: 'warning' } });
    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
    expect(serverLogs).toContainEqual(expect.objectContaining({
      level: 'debug',
      tag: 'codex-app-server',
      msg: expect.stringContaining('turn/completed thread=thread-1 turn=turn-1 status=completed durationMs=12'),
    }));
  });

  it('records interrupted turn completion without surfacing it as an execution error', async () => {
    const app = new FakeAppServer({
      'turn/start': () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-interrupted' } });
        app.fire('turn/completed', turnCompleted('turn-interrupted', 'interrupted', null, 34));
        return { turn: { id: 'turn-interrupted' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'stop', cwd: '/repo' }, (message) => out.push(message));

    expect(out.find((message) => message.type === 'error')).toBeUndefined();
    expect(serverLogs).toContainEqual(expect.objectContaining({
      level: 'debug',
      tag: 'codex-app-server',
      msg: expect.stringContaining('turn/completed thread=thread-1 turn=turn-interrupted status=interrupted durationMs=34'),
    }));
  });

  it('surfaces and records failed turn completion details', async () => {
    const app = new FakeAppServer({
      'turn/start': () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-failed' } });
        app.fire('turn/completed', turnCompleted('turn-failed', 'failed', {
          message: 'upstream unavailable for user@example.com',
          codexErrorInfo: { type: 'upstream' },
          additionalDetails: 'request_id=req-123',
        }, 56));
        return { turn: { id: 'turn-failed' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'fail', cwd: '/repo' }, (message) => out.push(message));

    expect(out).toContainEqual({
      type: 'error',
      error: 'codex: upstream unavailable for <redacted-email>',
    });
    expect(serverLogs).toContainEqual(expect.objectContaining({
      level: 'error',
      tag: 'codex-app-server',
      msg: expect.stringMatching(/turn\/completed thread=thread-1 turn=turn-failed status=failed durationMs=56 .*upstream unavailable for <redacted-email>.*request_id=req-123/),
    }));
  });

  it('fetches and logs a fresh bounded rate-limit snapshot after a 429 completion', async () => {
    const app = new FakeAppServer({
      'turn/start': () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-rate-limited' } });
        app.fire('turn/completed', turnCompleted('turn-rate-limited', 'failed', {
          message: 'exceeded retry limit, last status: 429 Too Many Requests',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        }, 352));
        return { turn: { id: 'turn-rate-limited' } };
      },
      'account/rateLimits/read': () => ({
        account: { email: 'must-not-log@example.com' },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: null,
            primary: {
              usedPercent: 99.6,
              windowDurationMins: 15,
              resetsAt: 1792465370,
            },
            rateLimitReachedType: 'primary',
            credits: [{ id: 'secret-credit-id' }],
          },
        },
      }),
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'retry', cwd: '/repo' }, (message) => out.push(message));

    await vi.waitFor(() => {
      expect(app.calls.filter((call) => call.method === 'account/rateLimits/read')).toHaveLength(1);
    });
    const snapshotLog = serverLogs.find((entry) => entry.msg.includes('rate-limit snapshot'));
    expect(snapshotLog).toMatchObject({ level: 'warn', tag: 'codex-app-server' });
    expect(snapshotLog?.msg).toContain('thread=thread-1 turn=turn-rate-limited');
    expect(snapshotLog?.msg).toContain('"limitId":"codex"');
    expect(snapshotLog?.msg).toContain('"usedPercent":99.6');
    expect(snapshotLog?.msg).toContain('"windowDurationMins":15');
    expect(snapshotLog?.msg).toContain('"resetsAt":1792465370');
    expect(snapshotLog?.msg).toContain('"rateLimitReachedType":"primary"');
    expect(snapshotLog?.msg).not.toContain('must-not-log@example.com');
    expect(snapshotLog?.msg).not.toContain('secret-credit-id');
    expect(out).toContainEqual({ type: 'error', error: 'codex: exceeded retry limit, last status: 429 Too Many Requests' });
    expect(out.filter((message) => message.type === 'status' && message.state === 'idle')).toHaveLength(1);
  });

  it('keeps the original 429 visible when the fresh rate-limit read fails', async () => {
    const app = new FakeAppServer({
      'turn/start': () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-rate-limit-read-failed' } });
        app.fire('turn/completed', turnCompleted('turn-rate-limit-read-failed', 'failed', {
          message: '429 Too Many Requests',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        }));
        return { turn: { id: 'turn-rate-limit-read-failed' } };
      },
      'account/rateLimits/read': () => {
        throw new Error('lookup failed for user@example.com access_token: secret');
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'retry', cwd: '/repo' }, (message) => out.push(message));

    await vi.waitFor(() => {
      expect(serverLogs.some((entry) => entry.msg.includes('rate-limit snapshot read failed'))).toBe(true);
    });
    const warning = serverLogs.find((entry) => entry.msg.includes('rate-limit snapshot read failed'));
    expect(warning).toMatchObject({ level: 'warn', tag: 'codex-app-server' });
    expect(warning?.msg).toContain('thread=thread-1 turn=turn-rate-limit-read-failed');
    expect(warning?.msg).not.toContain('user@example.com');
    expect(warning?.msg).not.toContain('access_token: secret');
    expect(out).toContainEqual({ type: 'error', error: 'codex: 429 Too Many Requests' });
    expect(out.filter((message) => message.type === 'status' && message.state === 'idle')).toHaveLength(1);
  });

  it('fails loud when turn completion omits a valid status', async () => {
    const app = new FakeAppServer({
      'turn/start': () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-malformed' } });
        app.fire('turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-malformed', durationMs: 78, error: null },
        });
        return { turn: { id: 'turn-malformed' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'malformed', cwd: '/repo' }, (message) => out.push(message));

    expect(out).toContainEqual({
      type: 'error',
      error: 'codex: app-server turn/completed returned invalid status <missing>',
    });
    expect(serverLogs).toContainEqual(expect.objectContaining({
      level: 'error',
      tag: 'codex-app-server',
      msg: expect.stringContaining('turn/completed thread=thread-1 turn=turn-malformed status=<missing> durationMs=78'),
    }));
  });

  it('resumes a persisted app-server thread id and rejects resume id mismatch', async () => {
    const ok = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => ok });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'again', cwd: '/repo', restoreContext: restoreContext('thread-existing') }, (m) => out.push(m));

    expect(ok.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({ threadId: 'thread-existing' });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'thread-existing' } });

    const mismatch = new FakeAppServer({
      'thread/resume': () => ({ thread: { id: 'fresh-thread' } }),
    });
    const mismatchBackend = createCodexBackend({ createAppServer: () => mismatch });
    const mismatchOut: OutgoingMessage[] = [];

    await mismatchBackend.query({ prompt: 'again', cwd: '/repo', restoreContext: restoreContext('missing-thread') }, (m) => mismatchOut.push(m));

    expect(mismatchOut.find((m) => m.type === 'context_patch')).toBeUndefined();
    expect(mismatchOut[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/resume thread mismatch/) });
  });

  it('starts a new thread when the persisted Codex rollout no longer exists', async () => {
    const app = new FakeAppServer({
      'thread/resume': () => {
        throw new Error('codex app-server thread/resume failed: {"code":-32600,"message":"no rollout found for thread id thread-missing"}');
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query(
      { prompt: 'recover', cwd: '/repo', restoreContext: restoreContext('thread-missing') },
      (m) => out.push(m),
    );

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'thread/resume', 'thread/start', 'turn/start']);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'thread-1' } });
    expect(out).toContainEqual(expect.objectContaining({
      type: 'message',
      msgType: 'system',
      content: 'Previous Codex thread was unavailable; started a new thread.',
    }));
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('does not hide unrelated thread/resume failures behind a new thread', async () => {
    const app = new FakeAppServer({
      'thread/resume': () => {
        throw new Error('codex app-server thread/resume failed: authentication expired');
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query(
      { prompt: 'again', cwd: '/repo', restoreContext: restoreContext('thread-existing') },
      (m) => out.push(m),
    );

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'thread/resume']);
    expect(out.find((m) => m.type === 'context_patch')).toBeUndefined();
    expect(out).toContainEqual(expect.objectContaining({
      type: 'error',
      error: expect.stringContaining('authentication expired'),
    }));
  });

  it('sends image-only turns as app-server localImage input', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: ' ', cwd: '/repo', images: ['/tmp/a.png'] }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      input: [{ type: 'localImage', path: '/tmp/a.png' }],
    });
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('sends uploaded renderer images as app-server localImage input', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({
      prompt: 'see',
      cwd: '/repo',
      attachments: [{ kind: 'image', path: '/repo/.tmp/shelf/a.png', displayPath: '.tmp/shelf/a.png', name: 'a.png', mimeType: 'image/png' }],
    }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      input: [
        { type: 'text', text: 'see', text_elements: [] },
        { type: 'localImage', path: '/repo/.tmp/shelf/a.png' },
      ],
    });
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('rejects legacy data URI images before app-server can treat them as paths', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'see', cwd: '/repo', images: ['data:image/png;base64,QUJD'] }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'turn/start')).toBeUndefined();
    expect(out.find((m) => m.type === 'error')).toMatchObject({
      type: 'error',
      error: expect.stringContaining('data URL images must be uploaded'),
    });
  });

  it('sends remote image URLs as app-server image URL input', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'see', cwd: '/repo', images: ['https://example.test/a.png'] }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      input: [
        { type: 'text', text: 'see', text_elements: [] },
        { type: 'image', url: 'https://example.test/a.png' },
      ],
    });
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('confirms config-edit through app-server settings without starting a turn', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.gatherCapabilities!('/repo', undefined, [{ id: 'gpt-5-codex' }]);
    app.calls = [];
    await backend.query({ prompt: '', cwd: '/repo', configEdit: { key: 'model', value: 'gpt-5-codex' } }, (m) => out.push(m));

    expect(app.calls.map(call => call.method)).toEqual(['thread/settings/update']);
    expect(out.some((m) => m.type === 'capabilities' && m.currentModel === 'gpt-5-codex')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('rejects concurrent turns defensively and idles the rejected turn once', async () => {
    let release!: () => void;
    const app = new FakeAppServer({
      'turn/start': async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        app.fire('turn/completed', turnCompleted('turn-1'));
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
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

  it('interrupts the active app-server turn on stop and still idles once', async () => {
    let release!: () => void;
    const app = new FakeAppServer({
      'turn/start': async () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        await new Promise<void>((resolve) => { release = resolve; });
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];
    const running = backend.query({ prompt: 'first', cwd: '/repo' }, (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await backend.stop();
    release();
    await running;

    expect(app.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-1', executionId: 'turn-1' });
    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
  });

  it('force-closes app-server when interrupt fails instead of reporting a false stop', async () => {
    let release!: () => void;
    const app = new FakeAppServer({
      'turn/start': async () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        await new Promise<void>((resolve) => { release = resolve; });
        return { turn: { id: 'turn-1' } };
      },
      'turn/interrupt': () => { throw new Error('interrupt transport failed'); },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const running = backend.query({ prompt: 'first', cwd: '/repo' }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(backend.stop()).resolves.toBeUndefined();
    release();
    await running;

    expect(app.closed).toBe(true);
  });

  it('force-closes idle app-server and reconnects on the next turn', async () => {
    const apps = [new FakeAppServer(), new FakeAppServer()];
    let appIndex = 0;
    const backend = createCodexBackend({ createAppServer: () => apps[appIndex++] });

    await backend.query({ prompt: 'first', cwd: '/repo' }, () => {});
    await expect(backend.stop()).resolves.toBeUndefined();
    await backend.query({
      prompt: 'second', cwd: '/repo', restoreContext: restoreContext('thread-1'),
    }, () => {});

    expect(apps[0].closed).toBe(true);
    expect(apps[1].calls.some((call) => call.method === 'thread/resume')).toBe(true);
    backend.dispose();
  });

  it('bridges command execution approval requests to Shelf permission UI and returns the decision', async () => {
    let approval!: Promise<unknown>;
    let release!: () => void;
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const app = new FakeAppServer({
      'turn/start': async () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        approval = app.serverRequest('item/commandExecution/requestApproval', {
          threadId: 'thread-1',
          executionId: 'turn-1',
          itemId: 'cmd-1',
          approvalId: 'approval-1',
          command: 'touch a.txt',
          cwd: '/repo',
          reason: 'write file',
          commandActions: [{ type: 'create_file' }],
        });
        await approval;
        await finish;
        app.fire('turn/completed', turnCompleted('turn-1'));
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];
    const running = backend.query({ prompt: 'write file', cwd: '/repo' }, (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(out).toContainEqual({
      type: 'permission_request',
      toolUseId: 'approval-1',
      toolName: 'Command',
      input: { command: 'touch a.txt', cwd: '/repo', reason: 'write file', commandActions: [{ type: 'create_file' }] },
    });
    backend.resolvePermission!('approval-1', true, undefined, 'session');
    await expect(approval).resolves.toEqual({ decision: 'acceptForSession' });
    release();
    await running;
  });

  it('uses commandExecution outputDelta as command card result when completed item has no aggregate output', async () => {
    const app = new FakeAppServer({
      'turn/start': async () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        app.fire('item/started', {
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'git status --short',
            status: 'inProgress',
            aggregatedOutput: null,
            exitCode: null,
          },
        });
        app.fire('item/commandExecution/outputDelta', {
          threadId: 'thread-1',
          executionId: 'turn-1',
          itemId: 'cmd-1',
          delta: ' M file.txt\n',
        });
        app.fire('item/completed', {
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'git status --short',
            status: 'completed',
            aggregatedOutput: null,
            exitCode: 0,
          },
        });
        app.fire('turn/completed', turnCompleted('turn-1'));
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'check status', cwd: '/repo' }, (m) => out.push(m));

    expect(out).toContainEqual({
      type: 'message',
      msgId: 'cmd-1',
      msgType: 'fold_code',
      label: 'Command',
      subtitle: 'git status --short',
      body: { content: ' M file.txt\n' },
    });
  });

  it('renders reasoning only after app-server reasoning deltas provide content', async () => {
    const app = new FakeAppServer({
      'turn/start': async () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        app.fire('item/started', {
          item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] },
        });
        app.fire('item/reasoning/summaryTextDelta', {
          threadId: 'thread-1',
          executionId: 'turn-1',
          itemId: 'reason-1',
          delta: 'checking state',
          summaryIndex: 0,
        });
        app.fire('item/completed', {
          item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] },
        });
        app.fire('turn/completed', turnCompleted('turn-1'));
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'think', cwd: '/repo' }, (m) => out.push(m));

    expect(out.filter((m) => m.type === 'message' && m.msgId === 'reason-1')).toEqual([
      {
        type: 'message',
        msgId: 'reason-1',
        msgType: 'fold_text',
        label: 'Reasoning',
        body: { content: 'checking state', tone: 'muted' },
      },
      {
        type: 'message',
        msgId: 'reason-1',
        msgType: 'fold_text',
        label: 'Reasoning',
        body: { content: 'checking state', tone: 'muted' },
      },
    ]);
  });

  it('bridges file change and permission profile approvals with deny/allow responses', async () => {
    let fileApproval!: Promise<unknown>;
    let permissionApproval!: Promise<unknown>;
    let release!: () => void;
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const app = new FakeAppServer({
      'turn/start': async () => {
        app.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        fileApproval = app.serverRequest('item/fileChange/requestApproval', {
          threadId: 'thread-1',
          executionId: 'turn-1',
          itemId: 'file-1',
          reason: 'apply patch',
          grantRoot: '/repo',
        });
        await fileApproval;
        permissionApproval = app.serverRequest('item/permissions/requestApproval', {
          threadId: 'thread-1',
          executionId: 'turn-1',
          itemId: 'perm-1',
          cwd: '/repo',
          reason: 'network',
          permissions: { network: { enabled: true }, fileSystem: null },
        });
        await permissionApproval;
        await finish;
        app.fire('turn/completed', turnCompleted('turn-1'));
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];
    const running = backend.query({ prompt: 'patch and network', cwd: '/repo' }, (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(out.some((m) => m.type === 'permission_request' && m.toolUseId === 'file-1')).toBe(true);
    backend.resolvePermission!('file-1', false, 'no');
    await expect(fileApproval).resolves.toEqual({ decision: 'decline' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(out.some((m) => m.type === 'permission_request' && m.toolUseId === 'perm-1')).toBe(true);
    backend.resolvePermission!('perm-1', true, undefined, 'once');
    await expect(permissionApproval).resolves.toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
      strictAutoReview: false,
    });
    release();
    await running;
  });

  it('reports app-server model/list capabilities and uses native effort and independent permission intent', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });

    const caps = await backend.gatherCapabilities!(
      '/repo',
      undefined,
      [{ id: 'custom-model' }],
      { model: 'gpt-5.6-sol', effort: 'ultra', nativePermission: ':read-only', nativeApproval: 'never' },
      undefined,
      'app-1',
    );

    expect(app.calls.map((call) => call.method)).toEqual(expect.arrayContaining(['initialize', 'account/read', 'model/list', 'permissionProfile/list', 'thread/start']));
    expect(caps.models.map((m) => m.value)).toEqual(['gpt-5.6-sol', 'custom-model']);
    expect(caps.models[0].effortLevels?.map((e) => e.value)).toEqual(['low', 'ultra']);
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('gpt-5.6-sol');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('ultra');
    expect(caps.permissionControl).toMatchObject({ strategy: 'native', permission: { currentValue: ':read-only' }, approval: { currentValue: 'never' } });
    expect(caps.confirmedPrefs).toEqual({});
    expect(caps.slashCommands.map((cmd) => cmd.name)).toEqual([
      'status',
      'usage',
      'mcp',
      'skills',
      'skill',
      'compact',
      'clear',
      'new',
      'review',
      'diff',
      'goal',
      'rename',
      'logout',
      'ps',
      'stop',
      'clean',
    ]);
  });

  it('resumes during initialization and omits unset prefs on both init and subsequent turns', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];
    backend.bindSessionSend!((message) => out.push(message));
    await backend.gatherCapabilities!('/repo', 'session', undefined, {}, undefined, undefined, restoreContext('saved-thread'));
    const resume = app.calls.find(call => call.method === 'thread/resume')!.params as Record<string, unknown>;
    expect(resume).toMatchObject({ threadId: 'saved-thread', cwd: '/repo' });
    for (const key of ['model', 'effort', 'permissions', 'approvalPolicy', 'sandbox']) expect(resume).not.toHaveProperty(key);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'saved-thread' } });
    await backend.query({ prompt: 'hi', cwd: '/repo' }, message => out.push(message));
    expect(app.calls.filter(call => call.method === 'thread/resume')).toHaveLength(1);
    expect(app.calls.find(call => call.method === 'turn/start')!.params).not.toHaveProperty('effort');
  });

  it('does not silently replace an invalid saved model with the first catalog entry', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    await expect(backend.gatherCapabilities!('/repo', undefined, undefined, { model: 'retired' })).rejects.toThrow('saved model');
    expect(app.calls.some(call => call.method === 'thread/start')).toBe(false);
  });

  it('reports auth required before listing models when app-server has no OpenAI account', async () => {
    const app = new FakeAppServer({
      'account/read': () => ({ account: null, requiresOpenaiAuth: true }),
    });
    const backend = createCodexBackend({ createAppServer: () => app });

    const caps = await backend.gatherCapabilities!('/repo', undefined, undefined, undefined, undefined, 'app-1');

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'account/read']);
    expect(caps).toMatchObject({
      authRequired: true,
      authMethod: {
        kind: 'oauth',
        instructions: [{ label: 'Sign in with your ChatGPT account (device code)' }],
      },
    });
  });

  it('does not require OpenAI auth when the active app-server provider does not need it', async () => {
    const app = new FakeAppServer({
      'account/read': () => ({ account: null, requiresOpenaiAuth: false }),
    });
    const backend = createCodexBackend({ createAppServer: () => app });

    const caps = await backend.gatherCapabilities!('/repo', undefined, undefined, undefined, undefined, 'app-1');

    expect(app.calls.map((call) => call.method)).toEqual(expect.arrayContaining(['initialize', 'account/read', 'model/list', 'permissionProfile/list', 'thread/start']));
    expect(caps.authRequired).not.toBe(true);
  });

  it('fails loudly when account/read does not return a definitive auth state', async () => {
    const app = new FakeAppServer({
      'account/read': () => ({ account: null }),
    });
    const backend = createCodexBackend({ createAppServer: () => app });

    await expect(backend.gatherCapabilities!('/repo', undefined, undefined, undefined, undefined, 'app-1'))
      .rejects.toThrow('account/read returned an invalid auth state');
  });

  it('respawns app-server on reconnect so the post-login probe reads fresh credentials', async () => {
    const beforeLogin = new FakeAppServer({
      'account/read': () => ({ account: null, requiresOpenaiAuth: true }),
    });
    const afterLogin = new FakeAppServer();
    const createAppServer = vi.fn()
      .mockReturnValueOnce(beforeLogin)
      .mockReturnValueOnce(afterLogin);
    const backend = createCodexBackend({ createAppServer });

    await expect(backend.gatherCapabilities!('/repo', undefined, undefined, undefined, undefined, 'app-1'))
      .resolves.toMatchObject({ authRequired: true });
    backend.reconnect!();
    const caps = await backend.gatherCapabilities!('/repo', undefined, undefined, undefined, undefined, 'app-1');

    expect(beforeLogin.closed).toBe(true);
    expect(createAppServer).toHaveBeenCalledTimes(2);
    expect(caps.authRequired).not.toBe(true);
  });

  it('confirms typed config slashes through the same native settings route', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.gatherCapabilities!('/repo', undefined, [{ id: 'gpt-5-codex' }]);
    app.calls = [];
    await backend.query({ prompt: '/model gpt-5-codex', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map(call => call.method)).toEqual(['thread/settings/update']);
    expect(out.some((m) => m.type === 'capabilities' && m.currentModel === 'gpt-5-codex')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('routes /mcp and /skills to app-server list routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/mcp', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));
    await backend.query({ prompt: '/skills', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'mcpServerStatus/list', 'skills/list']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('`shelf`'))).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('`skill-a`'))).toBe(true);
  });

  it('reports /status locally after app-server initialization', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/status', cwd: '/repo', model: 'gpt-5.4-mini', effort: 'medium', permissionMode: 'bypassPermissions' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('gpt-5.4-mini'))).toBe(true);
  });

  it('routes /usage to app-server account usage and rate-limit routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/usage', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'account/rateLimits/read', 'account/usage/read']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('7d: 7%'))).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('Total tokens: 12,345'))).toBe(true);
  });

  it('clears persisted app-server context locally', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/clear', cwd: '/repo', restoreContext: restoreContext('thread-1') }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system' && m.content.includes('Cleared'))).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('starts a new local Codex thread context with /new', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/new', cwd: '/repo', restoreContext: restoreContext('thread-1') }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system' && m.content.includes('new Codex thread'))).toBe(true);
  });

  it('routes /compact through thread/compact/start', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/compact', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'thread/start', 'thread/compact/start']);
    expect(out).toContainEqual({ type: 'message', msgId: 'compact-1', msgType: 'system', content: 'Context compacted.' });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('routes /review through review/start for uncommitted changes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/review', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'review/start')?.params).toMatchObject({
      threadId: 'thread-1',
      target: { type: 'uncommittedChanges' },
    });
    expect(out).toContainEqual({ type: 'message', msgId: 'review-1', msgType: 'reply', content: 'reviewed' });
  });

  it('routes /diff through gitDiffToRemote without starting a thread', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/diff', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'gitDiffToRemote']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('```diff'))).toBe(true);
  });

  it('gets, sets, and clears Codex goals through thread goal routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/goal', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/goal finish slash commands', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/goal clear', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual([
      'initialize',
      'thread/start',
      'thread/goal/get',
      'thread/goal/set',
      'thread/goal/clear',
    ]);
    expect(app.calls.find((call) => call.method === 'thread/goal/set')?.params).toMatchObject({ objective: 'finish slash commands' });
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('ship it'))).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system' && m.content.includes('Cleared Codex goal'))).toBe(true);
  });

  it('routes /rename and /logout through app-server account/thread routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/rename focused work', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/logout', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'thread/name/set')?.params).toMatchObject({ threadId: 'thread-1', name: 'focused work' });
    expect(app.calls.some((call) => call.method === 'account/logout')).toBe(true);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
  });

  it('surfaces app-server schema gaps for background-task slash commands', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/ps', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/stop', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/clean', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out.filter((m) => m.type === 'message' && m.msgType === 'error' && m.content.includes('not available'))).toHaveLength(3);
  });

  it('declares isolated config home and SDK HOME-scoped skill target until app-server skill roots are finalized', () => {
    const backend = createCodexBackend();
    expect(backend.configHome!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'));
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-home', '.agents', 'skills'));
    expect(backend.configHome!(undefined)).toBeUndefined();
    expect(backend.skillTarget!(undefined)).toBeUndefined();
  });

  it('builds app-scoped env, required shelf MCP, user MCP, and secret-safe config for thread/start', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const app = new FakeAppServer();
    const backend = createCodexBackend({
      createAppServer: (env) => {
        envs.push(env);
        return app;
      },
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

    expect(envs[0]).toMatchObject({
      CODEX_HOME: path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'),
      HOME: path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-home'),
    });
    const threadStart = app.calls.find((call) => call.method === 'thread/start')!;
    expect(threadStart.params).toMatchObject({
      config: {
        mcp_servers: {
          shelf: { url: 'http://127.0.0.1:9/mcp', required: true },
          gh: { command: 'node', args: ['server.js'], env_vars: ['GITHUB_TOKEN'] },
        },
      },
    });
    expect(JSON.stringify(threadStart.params)).not.toContain('secret-token');
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('uses native profile and approval on init and does not overwrite them on turns', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({ createAppServer: () => app });

    await backend.gatherCapabilities!('/repo', undefined, undefined, { nativePermission: ':read-only', nativeApproval: 'never' });
    await backend.query({ prompt: 'hi', cwd: '/repo' }, () => {});

    const threadStart = app.calls.find((call) => call.method === 'thread/start')?.params as Record<string, unknown>;
    const turnStart = app.calls.find((call) => call.method === 'turn/start')?.params as Record<string, unknown>;
    expect(threadStart).toMatchObject({ approvalPolicy: 'never', permissions: ':read-only' });
    expect(threadStart.sandboxPolicy).toBeUndefined();
    expect(turnStart.approvalPolicy).toBeUndefined();
    expect(turnStart.sandboxPolicy).toBeUndefined();
    expect(turnStart.sandbox).toBeUndefined();
  });

  it('surfaces projected MCP config errors before turn/start', async () => {
    const app = new FakeAppServer();
    const backend = createCodexBackend({
      createAppServer: () => app,
      loadMcpServers: () => ({ servers: {}, errors: ['MCP server "gh" references env var(s) not set on this host: TOKEN'] }),
    });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'hi', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/MCP server "gh"/) });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('stamps auth events with the temporary provider id', async () => {
    const rpc = fakeRpc();
    const backend = createCodexBackend({ spawnLoginRpc: () => ({ rpc }) });
    const out: OutgoingMessage[] = [];

    backend.startLogin!('/repo', (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rpc.fireCompleted(true);

    expect(out[0]).toMatchObject({ type: 'auth_login_prompt', provider: CODEX_AUTH_DISPLAY_NAME });
    expect(out.at(-1)).toEqual({
      type: 'auth_login_done',
      provider: CODEX_AUTH_DISPLAY_NAME,
      ok: true,
    });
  });

  it('exposes a post-turn account status refresh hook', async () => {
    const refreshAccountStatus = vi.fn(async (_cache, send) => {
      send({ type: 'status', rateLimits: [{ text: '7d: 1%', severity: 'normal' }] });
    });
    const backend = createCodexBackend({ refreshAccountStatus });
    const out: OutgoingMessage[] = [];

    await backend.refreshAccountStatus!(undefined, (m) => out.push(m), 'app-1');

    expect(refreshAccountStatus).toHaveBeenCalledWith(undefined, expect.any(Function), 'app-1');
    expect(out).toEqual([{ type: 'status', rateLimits: [{ text: '7d: 1%', severity: 'normal' }] }]);
  });
});
