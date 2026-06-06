import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tab-open auth detection for Copilot. Unlike Claude (no auth API → warmup +
 * accountInfo heuristic), Copilot's SDK exposes a first-class
 * `client.getAuthStatus() → { isAuthenticated }`. The probe mechanism differs,
 * but the SHARED contract is identical: gatherCapabilities returns
 * `authRequired`, and everything above (auth_required routing → AuthPane →
 * checkAuth) is reused unchanged.
 */

const h = vi.hoisted(() => ({
  authResult: { isAuthenticated: true } as { isAuthenticated: boolean },
  authThrows: false,
  listModelsCalls: 0,
}));

// resolveCopilotCliPath() walks fs.existsSync candidates; make one resolve so
// ensureClient() reaches `new CopilotClient` instead of throwing "not found".
vi.mock('fs', () => ({ existsSync: () => true }));

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    async start() { /* noop */ }
    async getAuthStatus() {
      if (h.authThrows) throw new Error('control error');
      return h.authResult;
    }
    async listModels() {
      h.listModelsCalls++;
      return [{ id: 'gpt-5.5', name: 'GPT-5.5', supportedReasoningEfforts: [] }];
    }
    async stop() { /* noop */ }
  },
}));

import { createCopilotBackend } from './index';

describe('copilot gatherCapabilities authRequired', () => {
  beforeEach(() => {
    h.authResult = { isAuthenticated: true };
    h.authThrows = false;
    h.listModelsCalls = 0;
  });

  it('signed in → authRequired false, models fetched', async () => {
    const backend = createCopilotBackend();
    const caps = await backend.gatherCapabilities!('/tmp');
    expect(caps.authRequired).toBe(false);
    expect(h.listModelsCalls).toBe(1);
    expect(caps.models.length).toBeGreaterThan(0);
  });

  it('logged out → authRequired true, listModels SKIPPED (would throw/hang)', async () => {
    h.authResult = { isAuthenticated: false };
    const backend = createCopilotBackend();
    const caps = await backend.gatherCapabilities!('/tmp');
    expect(caps.authRequired).toBe(true);
    expect(h.listModelsCalls).toBe(0);
  });

  it('getAuthStatus throws → unknown: authRequired false (do not block the pane)', async () => {
    h.authThrows = true;
    const backend = createCopilotBackend();
    const caps = await backend.gatherCapabilities!('/tmp');
    expect(caps.authRequired).toBe(false);
  });

  it('auth instructions are remote-aware (`copilot login`, no gh)', async () => {
    h.authResult = { isAuthenticated: false };
    const backend = createCopilotBackend();
    const caps = await backend.gatherCapabilities!('/tmp');
    const cmds = (caps.authMethod as any).instructions.map((i: any) => i.command).join(' ');
    expect(cmds).toContain('copilot login');
    expect(cmds).not.toContain('gh ');
  });
});
