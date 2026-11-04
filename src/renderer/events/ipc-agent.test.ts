import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { bindAgentIPCGroup } from './ipc-agent';
import { onAgent, emitAgent } from './types';
import { __resetBusForTests } from './bus';
import { SHELF_MCP, SHELF_MCP_STATE, SHELF_MCP_FAILURE } from '../../shared/shelf-mcp';
import { beginPendingCancel, finishPendingCancel, cancelPendingSend } from '../agentTabStore';
import { QUEUE_CANCEL as C } from '../../shared/agent-queue-cancel';
import { SUBMISSION_ERROR as E, submissionFailed } from '../../shared/agent-submission';
vi.mock('../agentTabStore', () => ({ cancelPendingSend: vi.fn(), beginPendingCancel: vi.fn(() => true), finishPendingCancel: vi.fn() }));

// Mock the agent IPC surface. Each on* method stores its callback so
// tests can fire it synchronously; each outbound method records calls
// so we can assert event → IPC forwarding.
function makeMockAgentApi() {
  const callbacks: Record<string, (...args: any[]) => void> = {};
  const calls: Array<{ method: string; args: any[] }> = [];
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return Promise.resolve(true);
  };
  const listener = (key: string) => (cb: (...args: any[]) => void) => {
    callbacks[key] = cb;
    return () => { delete callbacks[key]; };
  };
  return {
    api: {
      init: record('init'),
      send: record('send'),
      stop: record('stop'),
      cancelQueued: record('cancelQueued'),
      destroy: record('destroy'),
      resolvePermission: record('resolvePermission'),
      resolvePicker: record('resolvePicker'),
      storeCredential: record('storeCredential'),
      clearCredential: record('clearCredential'),
      checkAuth: record('checkAuth'),
      startLogin: record('startLogin'),
      cancelLogin: record('cancelLogin'),
      onMessage: listener('onMessage'),
      onStream: listener('onStream'),
      onStatus: listener('onStatus'),
      onPlan: listener('onPlan'),
      onBackgroundTasks: listener('onBackgroundTasks'),
      onQueue: listener('onQueue'),
      onShelfMcpStatus: listener('onShelfMcpStatus'),
      onPermissionRequest: listener('onPermissionRequest'),
      onPickerRequest: listener('onPickerRequest'),
      onCapabilities: listener('onCapabilities'),
      onAuthRequired: listener('onAuthRequired'),
      onLoginPrompt: listener('onLoginPrompt'),
      onLoginDone: listener('onLoginDone'),
      onInitStatus: listener('onInitStatus'),
    },
    callbacks,
    calls,
  };
}

describe('bindAgentIPCGroup', () => {
  it('forwards Shelf startup state and cleans up the subscription', () => {
    const handler = vi.fn();
    const off = onAgent(SHELF_MCP.STATUS_EVENT, handler);
    const status = { state: SHELF_MCP_STATE.UNAVAILABLE, reason: SHELF_MCP_FAILURE.LISTENER };
    mock.callbacks.onShelfMcpStatus('tab-1', status);
    expect(handler).toHaveBeenCalledExactlyOnceWith({ tabId: 'tab-1', status });
    off();
  });
  let mock: ReturnType<typeof makeMockAgentApi>;
  let cleanup: () => void;

  beforeEach(() => {
    vi.mocked(beginPendingCancel).mockReset().mockReturnValue(true);
    vi.mocked(finishPendingCancel).mockClear();
    __resetBusForTests();
    mock = makeMockAgentApi();
    (globalThis as any).window = { shelfApi: { agent: mock.api } };
    cleanup = bindAgentIPCGroup();
  });

  afterEach(() => {
    cleanup();
    __resetBusForTests();
    delete (globalThis as any).window;
  });

  describe('inbound (IPC → bus)', () => {
    it('forwards onMessage to agent:onMessage', () => {
      const handler = vi.fn();
      onAgent('agent:onMessage', handler);
      mock.callbacks.onMessage('tab-1', { type: 'text', content: 'hi' });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', msg: { type: 'text', content: 'hi' } });
    });

    it('forwards onStream to agent:onStream', () => {
      const handler = vi.fn();
      onAgent('agent:onStream', handler);
      mock.callbacks.onStream('tab-1', { msgId: 'm1', content: 'delta' });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', chunk: { msgId: 'm1', content: 'delta' } });
    });

    it('forwards onStatus to agent:onStatus', () => {
      const handler = vi.fn();
      onAgent('agent:onStatus', handler);
      mock.callbacks.onStatus('tab-1', { state: 'streaming' });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', status: { state: 'streaming' } });
    });

    it('forwards onBackgroundTasks to agent:onBackgroundTasks', () => {
      const handler = vi.fn();
      onAgent('agent:onBackgroundTasks', handler);
      const event = { kind: 'started', task: { id: 't1', type: 'shell', label: 'x', status: 'running', done: false } };
      mock.callbacks.onBackgroundTasks('tab-1', event);
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', event });
    });

    it('forwards onCapabilities to agent:onCapabilities', () => {
      const handler = vi.fn();
      onAgent('agent:onCapabilities', handler);
      mock.callbacks.onCapabilities('tab-1', { currentModel: 'opus' });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', caps: { currentModel: 'opus' } });
    });

    it('forwards onPermissionRequest', () => {
      const handler = vi.fn();
      onAgent('agent:onPermissionRequest', handler);
      mock.callbacks.onPermissionRequest('tab-1', { toolUseId: 'tu1' });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', req: { toolUseId: 'tu1' } });
    });

    it('forwards onPickerRequest', () => {
      const handler = vi.fn();
      onAgent('agent:onPickerRequest', handler);
      mock.callbacks.onPickerRequest('tab-1', { id: 'p1', prompts: [] });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', req: { id: 'p1', prompts: [] } });
    });

    it('forwards onAuthRequired', () => {
      const handler = vi.fn();
      onAgent('agent:onAuthRequired', handler);
      mock.callbacks.onAuthRequired('tab-1', 'claude');
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', provider: 'claude' });
    });

    it('forwards onLoginPrompt', () => {
      const handler = vi.fn();
      onAgent('agent:onLoginPrompt', handler);
      const prompt = { provider: 'copilot', verificationUri: 'https://github.com/login/device', userCode: '1E5E-903B', prefilledUri: 'https://github.com/login/device?user_code=1E5E-903B' };
      mock.callbacks.onLoginPrompt('tab-1', prompt);
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', prompt });
    });

    it('forwards onLoginDone', () => {
      const handler = vi.fn();
      onAgent('agent:onLoginDone', handler);
      const result = { provider: 'copilot', ok: true };
      mock.callbacks.onLoginDone('tab-1', result);
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', result });
    });

    it('forwards onInitStatus', () => {
      const handler = vi.fn();
      onAgent('agent:onInitStatus', handler);
      mock.callbacks.onInitStatus('tab-1', { state: 'ready' });
      expect(handler).toHaveBeenCalledWith({ tabId: 'tab-1', status: { state: 'ready' } });
    });
  });

  describe('outbound (bus → IPC)', () => {
    it('forwards agent:init to api.init with positional args', () => {
      emitAgent('agent:init', {
        tabId: 't1',
        cwd: '/x',
        connection: { type: 'local' } as any,
        provider: 'claude',
        sessionId: 's1',
      });
      const call = mock.calls.find((c) => c.method === 'init');
      expect(call).toBeDefined();
      expect(call!.args).toEqual(['t1', '/x', { type: 'local' }, 'claude', 's1', undefined]);
    });

    it('forwards agent:send to api.send', () => {
      const attachments = [{ kind: 'image' as const, path: '/tmp/a.png', displayPath: '.tmp/shelf/a.png', name: 'a.png', mimeType: 'image/png' }];
      const inputMessage = { msgId: 'input-1', source: { kind: 'agent-view' as const }, content: 'hi', attachments, replyRequirement: 'none' as const };
      emitAgent('agent:send', { tabId: 't1', inputMessage });
      const call = mock.calls.find((c) => c.method === 'send');
      expect(call!.args).toEqual(['t1', { inputMessage }]);
    });
    it('removes a rejected optimistic input and shows a visible error instead of leaving a ghost queue chip', async () => {
      vi.spyOn(mock.api, 'send').mockResolvedValueOnce(submissionFailed(E.FORBIDDEN, 'Use Intervene before sending') as any);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = vi.fn(); const off = onAgent('agent:onMessage', message);
      try {
        emitAgent('agent:send', { tabId: 't1', inputMessage: { msgId: 'rejected', source: { kind: 'agent-view' }, content: 'blocked work', attachments: [], replyRequirement: 'none' } });
        await vi.waitFor(() => expect(message).toHaveBeenCalledWith({ tabId: 't1', msg: expect.objectContaining({ type: 'error' }) }));
        expect(cancelPendingSend).toHaveBeenCalledWith('t1', 'rejected');
      } finally { off(); logged.mockRestore(); }
    });

    it.each([E.TIMEOUT, E.UNCONFIRMED, E.DUPLICATE])('shows %s without deleting a possibly accepted input', async code => {
      vi.mocked(cancelPendingSend).mockClear();
      vi.spyOn(mock.api, 'send').mockResolvedValueOnce(submissionFailed(code, 'Check delivery') as any);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = vi.fn(); const off = onAgent('agent:onMessage', message);
      try {
        emitAgent('agent:send', { tabId: 't1', inputMessage: { msgId: 'uncertain', source: { kind: 'agent-view' }, content: 'work', attachments: [], replyRequirement: 'none' } });
        await vi.waitFor(() => expect(message).toHaveBeenCalledWith({ tabId: 't1', msg: expect.objectContaining({ type: 'error', content: expect.stringContaining(code) }) }));
        expect(cancelPendingSend).not.toHaveBeenCalled();
      } finally { off(); logged.mockRestore(); }
    });

    it('handles IPC rejection as unknown delivery and keeps the optimistic input', async () => {
      vi.mocked(cancelPendingSend).mockClear();
      vi.spyOn(mock.api, 'send').mockRejectedValueOnce(new Error('IPC lost'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = vi.fn(); const off = onAgent('agent:onMessage', message);
      try {
        emitAgent('agent:send', { tabId: 't1', inputMessage: { msgId: 'lost', source: { kind: 'agent-view' }, content: 'work', attachments: [], replyRequirement: 'none' } });
        await vi.waitFor(() => expect(message).toHaveBeenCalledWith({ tabId: 't1', msg: expect.objectContaining({ content: expect.stringContaining('unconfirmed') }) }));
        expect(cancelPendingSend).not.toHaveBeenCalled();
      } finally { off(); logged.mockRestore(); }
    });

    it('forwards agent:stop to api.stop', () => {
      emitAgent('agent:stop', { tabId: 't1' });
      expect(mock.calls.find((c) => c.method === 'stop')!.args).toEqual(['t1']);
    });

    it('forwards agent:destroy to api.destroy', () => {
      emitAgent('agent:destroy', { tabId: 't1' });
      expect(mock.calls.find((c) => c.method === 'destroy')!.args).toEqual(['t1']);
    });

    it('forwards agent:resolvePermission', () => {
      emitAgent('agent:resolvePermission', { tabId: 't1', toolUseId: 'tu1', allow: true, scope: 'once' });
      expect(mock.calls.find((c) => c.method === 'resolvePermission')!.args)
        .toEqual(['t1', 'tu1', true, 'once']);
    });

    it('forwards agent:resolvePicker', () => {
      emitAgent('agent:resolvePicker', { tabId: 't1', pickerId: 'p1', payload: { cancelled: true } });
      expect(mock.calls.find((c) => c.method === 'resolvePicker')!.args)
        .toEqual(['t1', 'p1', { cancelled: true }]);
    });
  });

  describe('authoritative queue cancellation', () => {
    it('waits for remote confirmation before applying cancellation', async () => {
      let resolve!: (value: any) => void;
      vi.spyOn(mock.api, 'cancelQueued').mockImplementation(() => new Promise(r => { resolve = r; }));
      emitAgent('agent:cancelQueued', { tabId: 't1', clientMsgId: 'c1' });
      expect(beginPendingCancel).toHaveBeenCalledWith('t1', 'c1');
      expect(finishPendingCancel).not.toHaveBeenCalled();
      resolve({ status: C.STATUS.CANCELLED });
      await vi.waitFor(() => expect(finishPendingCancel).toHaveBeenCalledWith('t1', 'c1', { status: C.STATUS.CANCELLED }));
    });
    it('does not send a duplicate or already-promoted cancellation', () => {
      vi.mocked(beginPendingCancel).mockReturnValue(false);
      emitAgent('agent:cancelQueued', { tabId: 't1', clientMsgId: 'gone' });
      expect(mock.calls.some(c => c.method === 'cancelQueued')).toBe(false);
    });
    it('retains input and surfaces an unconfirmed cancellation', async () => {
      vi.spyOn(mock.api, 'cancelQueued').mockRejectedValueOnce(new Error('connection lost'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = vi.fn(); const off = onAgent('agent:onMessage', message);
      try {
        emitAgent('agent:cancelQueued', { tabId: 't1', clientMsgId: 'c1' });
        await vi.waitFor(() => expect(finishPendingCancel).toHaveBeenCalledWith('t1', 'c1'));
        expect(message).toHaveBeenCalledWith({ tabId: 't1', msg: expect.objectContaining({ content: expect.stringContaining('may still execute') }) });
      } finally { off(); logged.mockRestore(); }
    });
  });

  describe('cleanup', () => {
    it('removes inbound listeners — bus emit no longer fires after cleanup', () => {
      const handler = vi.fn();
      onAgent('agent:onMessage', handler);
      cleanup();
      // Calling the stored callback now would still emit because cleanup
      // only detaches the binder's subscription, not the user handler;
      // but the binder's own off* invalidated the IPC mock callback ref.
      // Verify by re-binding and ensuring no double-fire.
      mock = makeMockAgentApi();
      (globalThis as any).window = { shelfApi: { agent: mock.api } };
      cleanup = bindAgentIPCGroup();
      mock.callbacks.onMessage('tab-1', { type: 'text', content: 'hi' });
      expect(handler).toHaveBeenCalledTimes(1);  // only the new binder fires
    });

    it('removes outbound subscriptions — emit no longer hits IPC after cleanup', () => {
      cleanup();
      emitAgent('agent:send', { tabId: 't1', configEdit: { key: 'model', value: 'test' } });
      expect(mock.calls.find((c) => c.method === 'send')).toBeUndefined();
      // Re-bind for afterEach
      cleanup = bindAgentIPCGroup();
    });
  });
});
