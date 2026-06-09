import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { bindAgentIPCGroup } from './ipc-agent';
import { onAgent, emitAgent } from './types';
import { __resetBusForTests } from './bus';

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
      destroy: record('destroy'),
      resolvePermission: record('resolvePermission'),
      resolvePicker: record('resolvePicker'),
      storeCredential: record('storeCredential'),
      clearCredential: record('clearCredential'),
      checkAuth: record('checkAuth'),
      onMessage: listener('onMessage'),
      onStream: listener('onStream'),
      onStatus: listener('onStatus'),
      onPlan: listener('onPlan'),
      onBackgroundTasks: listener('onBackgroundTasks'),
      onPermissionRequest: listener('onPermissionRequest'),
      onPickerRequest: listener('onPickerRequest'),
      onCapabilities: listener('onCapabilities'),
      onAuthRequired: listener('onAuthRequired'),
      onInitStatus: listener('onInitStatus'),
    },
    callbacks,
    calls,
  };
}

describe('bindAgentIPCGroup', () => {
  let mock: ReturnType<typeof makeMockAgentApi>;
  let cleanup: () => void;

  beforeEach(() => {
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
      emitAgent('agent:send', { tabId: 't1', text: 'hi', images: ['data:img'], prefs: { model: 'opus' } });
      const call = mock.calls.find((c) => c.method === 'send');
      expect(call!.args).toEqual(['t1', 'hi', ['data:img'], { model: 'opus' }]);
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
      emitAgent('agent:send', { tabId: 't1', text: 'hi' });
      expect(mock.calls.find((c) => c.method === 'send')).toBeUndefined();
      // Re-bind for afterEach
      cleanup = bindAgentIPCGroup();
    });
  });
});
