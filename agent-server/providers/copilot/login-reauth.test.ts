import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OutgoingMessage } from '../types';

/**
 * Regression: after a SUCCESSFUL device-flow login, the copilot backend must
 * tear down the cached SDK client. The runtime is spawned UNAUTHENTICATED at
 * the tab-open auth probe (first ensureClient, before login) and never re-reads
 * the credential — so without this teardown the next turn reuses it and fails
 * with "No authentication info available" until a manual reconnect. Dropping
 * state.client on login-ok makes the next ensureClient spawn a fresh, authed
 * runtime.
 */
const h = vi.hoisted(() => ({
  clientInstances: 0,
  stopCalls: 0,
  resolveDone: null as null | ((r: any) => void),
}));

// resolveCopilotCliPath() walks fs.existsSync candidates; make one resolve so
// ensureClient() reaches `new CopilotClient` instead of throwing "not found".
vi.mock('fs', () => ({ existsSync: () => true }));

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    constructor() { h.clientInstances++; }
    async start() { /* noop */ }
    async getAuthStatus() { return { isAuthenticated: true }; }
    async listModels() { return [{ id: 'gpt-5.5', name: 'GPT-5.5', supportedReasoningEfforts: [] }]; }
    async stop() { h.stopCalls++; }
  },
  RuntimeConnection: { forStdio: (opts: any) => ({ kind: 'stdio', ...opts }) },
}));

vi.mock('./login', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return {
    ...actual, // keep the real prefillLoginUrl
    startLogin: (opts: any) => ({ cancel: vi.fn(), done: new Promise((r) => { h.resolveDone = r; }) }),
  };
});

import { createCopilotBackend } from './index';

describe('copilot backend re-auth after login', () => {
  beforeEach(() => {
    h.clientInstances = 0;
    h.stopCalls = 0;
    h.resolveDone = null;
  });

  it('login ok → tears down the cached client so the next turn rebuilds', async () => {
    const backend = createCopilotBackend();
    // tab-open auth probe spawns the (pre-login) client → state.client set.
    await backend.gatherCapabilities!('/tmp');
    expect(h.clientInstances).toBe(1);

    const sent: OutgoingMessage[] = [];
    backend.startLogin!('/tmp', (m) => sent.push(m));
    h.resolveDone!({ ok: true });

    await vi.waitFor(() => expect(h.stopCalls).toBe(1)); // stale client stopped

    // Next probe builds a FRESH client (the stale one was dropped).
    await backend.gatherCapabilities!('/tmp');
    expect(h.clientInstances).toBe(2);
    expect(sent).toContainEqual({ type: 'auth_login_done', provider: 'copilot', ok: true, cancelled: undefined, error: undefined });
    backend.dispose();
  });

  it('login failure → does NOT tear down the client (nothing to rebuild)', async () => {
    const backend = createCopilotBackend();
    await backend.gatherCapabilities!('/tmp');
    expect(h.clientInstances).toBe(1);

    backend.startLogin!('/tmp', () => { /* ignore */ });
    h.resolveDone!({ ok: false, error: 'nope' });
    await Promise.resolve(); await Promise.resolve();

    expect(h.stopCalls).toBe(0);
    // client still cached → no rebuild on the next probe.
    await backend.gatherCapabilities!('/tmp');
    expect(h.clientInstances).toBe(1);
    backend.dispose();
  });
});
