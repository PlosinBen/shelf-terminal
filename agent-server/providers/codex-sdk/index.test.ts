import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import { createCodexOfficialBackend } from './index';
import type { LoginRpc } from '../codex-shared/app-server-login';
import type { OutgoingMessage } from '../types';

interface RequestCall {
  method: string;
  params?: unknown;
}

class FakeAppServer {
  calls: RequestCall[] = [];
  closed = false;
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
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
    if (method === 'thread/resume') return { thread: { id: (params as { threadId: string }).threadId } } as T;
    if (method === 'turn/start') {
      this.fire('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
      this.fire('item/agentMessage/delta', { itemId: 'm1', delta: 'hel' });
      this.fire('item/agentMessage/delta', { itemId: 'm1', delta: 'lo' });
      this.fire('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'hello' } });
      this.fire('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 129_200 }, last: { inputTokens: 129_000, totalTokens: 129_200 }, modelContextWindow: 258_400 } });
      this.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
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
      this.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'review-turn' } });
      return { turn: { id: 'review-turn' } } as T;
    }
    if (method === 'thread/compact/start') {
      this.fire('item/completed', { item: { id: 'compact-1', type: 'contextCompaction' } });
      this.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'compact-turn' } });
      return { turn: { id: 'compact-turn' } } as T;
    }
    if (method === 'turn/interrupt') {
      this.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
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
    provider: CODEX_OFFICAL_PROVIDER,
    lastSdkSessionId,
    updatedAt: 1,
  };
}

describe('Codex official app-server backend lifecycle', () => {
  it('starts a new app-server thread, starts a turn, streams deltas, persists thread id, reports ctx, and idles once', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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
  });

  it('resumes a persisted app-server thread id and rejects resume id mismatch', async () => {
    const ok = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => ok });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: 'again', cwd: '/repo', restoreContext: restoreContext('thread-existing') }, (m) => out.push(m));

    expect(ok.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({ threadId: 'thread-existing' });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'thread-existing' } });

    const mismatch = new FakeAppServer({
      'thread/resume': () => ({ thread: { id: 'fresh-thread' } }),
    });
    const mismatchBackend = createCodexOfficialBackend({ createAppServer: () => mismatch });
    const mismatchOut: OutgoingMessage[] = [];

    await mismatchBackend.query({ prompt: 'again', cwd: '/repo', restoreContext: restoreContext('missing-thread') }, (m) => mismatchOut.push(m));

    expect(mismatchOut.find((m) => m.type === 'context_patch')).toBeUndefined();
    expect(mismatchOut[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/resume thread mismatch/) });
  });

  it('sends image-only turns as app-server localImage input', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: ' ', cwd: '/repo', images: ['/tmp/a.png'] }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      input: [{ type: 'localImage', path: '/tmp/a.png' }],
    });
    expect(out.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('applies config-edit locally without calling app-server turn routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '', cwd: '/repo', configEdit: { key: 'model', value: 'gpt-5-codex' } }, (m) => out.push(m));

    expect(app.calls).toEqual([]);
    expect(out.some((m) => m.type === 'capabilities' && m.currentModel === 'gpt-5-codex')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('rejects concurrent turns defensively and idles the rejected turn once', async () => {
    let release!: () => void;
    const app = new FakeAppServer({
      'turn/start': async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        app.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];
    const running = backend.query({ prompt: 'first', cwd: '/repo' }, (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await backend.stop();
    release();
    await running;

    expect(app.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(out.filter((m) => m.type === 'status' && m.state === 'idle')).toHaveLength(1);
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
          turnId: 'turn-1',
          itemId: 'cmd-1',
          approvalId: 'approval-1',
          command: 'touch a.txt',
          cwd: '/repo',
          reason: 'write file',
          commandActions: [{ type: 'create_file' }],
        });
        await approval;
        await finish;
        app.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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
          turnId: 'turn-1',
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
        app.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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
          turnId: 'turn-1',
          itemId: 'reason-1',
          delta: 'checking state',
          summaryIndex: 0,
        });
        app.fire('item/completed', {
          item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] },
        });
        app.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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
          turnId: 'turn-1',
          itemId: 'file-1',
          reason: 'apply patch',
          grantRoot: '/repo',
        });
        await fileApproval;
        permissionApproval = app.serverRequest('item/permissions/requestApproval', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'perm-1',
          cwd: '/repo',
          reason: 'network',
          permissions: { network: { enabled: true }, fileSystem: null },
        });
        await permissionApproval;
        await finish;
        app.fire('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
        return { turn: { id: 'turn-1' } };
      },
    });
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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

  it('reports app-server model/list capabilities and normalizes stale saved model intent', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });

    const caps = await backend.gatherCapabilities!(
      '/repo',
      undefined,
      [{ id: 'custom-model' }],
      { model: 'ask', effort: 'ultra', permissionMode: 'plan' },
      undefined,
      'app-1',
    );

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'model/list']);
    expect(caps.models.map((m) => m.value)).toEqual(['gpt-5.6-sol', 'custom-model']);
    expect(caps.models[0].effortLevels?.map((e) => e.value)).toEqual(['low', 'ultra']);
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('gpt-5.6-sol');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('ultra');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBe('plan');
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

  it('handles typed config slashes locally without app-server turn routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/model gpt-5-codex', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls).toEqual([]);
    expect(out.some((m) => m.type === 'capabilities' && m.currentModel === 'gpt-5-codex')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('routes /mcp and /skills to app-server list routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/mcp', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));
    await backend.query({ prompt: '/skills', cwd: '/repo', appId: 'app-1' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'mcpServerStatus/list', 'skills/list']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('`shelf`'))).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('`skill-a`'))).toBe(true);
  });

  it('reports /status locally after app-server initialization', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/status', cwd: '/repo', model: 'gpt-5.4-mini', effort: 'medium', permissionMode: 'bypassPermissions' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('gpt-5.4-mini'))).toBe(true);
  });

  it('routes /usage to app-server account usage and rate-limit routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/usage', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'account/rateLimits/read', 'account/usage/read']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('7d: 7%'))).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('Total tokens: 12,345'))).toBe(true);
  });

  it('clears persisted app-server context locally', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/clear', cwd: '/repo', restoreContext: restoreContext('thread-1') }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system' && m.content.includes('Cleared'))).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('starts a new local Codex thread context with /new', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/new', cwd: '/repo', restoreContext: restoreContext('thread-1') }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system' && m.content.includes('new Codex thread'))).toBe(true);
  });

  it('routes /compact through thread/compact/start', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/compact', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'thread/start', 'thread/compact/start']);
    expect(out).toContainEqual({ type: 'message', msgId: 'compact-1', msgType: 'system', content: 'Context compacted.' });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('routes /review through review/start for uncommitted changes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
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
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/diff', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize', 'gitDiffToRemote']);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('```diff'))).toBe(true);
  });

  it('gets, sets, and clears Codex goals through thread goal routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/goal', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/goal finish slash commands', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/goal clear', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual([
      'initialize',
      'thread/start',
      'thread/goal/get',
      'thread/start',
      'thread/goal/set',
      'thread/start',
      'thread/goal/clear',
    ]);
    expect(app.calls.find((call) => call.method === 'thread/goal/set')?.params).toMatchObject({ objective: 'finish slash commands' });
    expect(out.some((m) => m.type === 'message' && m.msgType === 'reply' && m.content.includes('ship it'))).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system' && m.content.includes('Cleared Codex goal'))).toBe(true);
  });

  it('routes /rename and /logout through app-server account/thread routes', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/rename focused work', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/logout', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.find((call) => call.method === 'thread/name/set')?.params).toMatchObject({ threadId: 'thread-1', name: 'focused work' });
    expect(app.calls.some((call) => call.method === 'account/logout')).toBe(true);
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
  });

  it('surfaces app-server schema gaps for background-task slash commands', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });
    const out: OutgoingMessage[] = [];

    await backend.query({ prompt: '/ps', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/stop', cwd: '/repo' }, (m) => out.push(m));
    await backend.query({ prompt: '/clean', cwd: '/repo' }, (m) => out.push(m));

    expect(app.calls.map((call) => call.method)).toEqual(['initialize']);
    expect(out.filter((m) => m.type === 'message' && m.msgType === 'error' && m.content.includes('not available'))).toHaveLength(3);
  });

  it('declares isolated config home and SDK HOME-scoped skill target until app-server skill roots are finalized', () => {
    const backend = createCodexOfficialBackend();
    expect(backend.configHome!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'));
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-sdk-home', '.agents', 'skills'));
    expect(backend.configHome!(undefined)).toBeUndefined();
    expect(backend.skillTarget!(undefined)).toBeUndefined();
  });

  it('builds app-scoped env, required shelf MCP, user MCP, and secret-safe config for thread/start', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({
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
      HOME: path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-sdk-home'),
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

  it('maps permission mode to thread sandbox and turn sandboxPolicy without mixing schema fields', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({ createAppServer: () => app });

    await backend.query({ prompt: 'hi', cwd: '/repo', permissionMode: 'plan' }, () => {});

    const threadStart = app.calls.find((call) => call.method === 'thread/start')?.params as Record<string, unknown>;
    const turnStart = app.calls.find((call) => call.method === 'turn/start')?.params as Record<string, unknown>;
    expect(threadStart).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
    expect(threadStart.sandboxPolicy).toBeUndefined();
    expect(turnStart).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    expect(turnStart.sandbox).toBeUndefined();
  });

  it('surfaces projected MCP config errors before turn/start', async () => {
    const app = new FakeAppServer();
    const backend = createCodexOfficialBackend({
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
    const backend = createCodexOfficialBackend({ spawnLoginRpc: () => ({ rpc }) });
    const out: OutgoingMessage[] = [];

    backend.startLogin!('/repo', (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rpc.fireCompleted(true);

    expect(out[0]).toMatchObject({ type: 'auth_login_prompt', provider: CODEX_OFFICAL_PROVIDER });
    expect(out.at(-1)).toEqual({ type: 'auth_login_done', provider: CODEX_OFFICAL_PROVIDER, ok: true });
  });

  it('exposes a post-turn account status refresh hook', async () => {
    const refreshAccountStatus = vi.fn(async (_cache, send) => {
      send({ type: 'status', rateLimits: [{ text: '7d: 1%', severity: 'normal' }] });
    });
    const backend = createCodexOfficialBackend({ refreshAccountStatus });
    const out: OutgoingMessage[] = [];

    await backend.refreshAccountStatus!(undefined, (m) => out.push(m), 'app-1');

    expect(refreshAccountStatus).toHaveBeenCalledWith(undefined, expect.any(Function), 'app-1');
    expect(out).toEqual([{ type: 'status', rateLimits: [{ text: '7d: 1%', severity: 'normal' }] }]);
  });
});
