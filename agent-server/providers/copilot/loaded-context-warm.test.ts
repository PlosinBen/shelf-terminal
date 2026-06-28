import { describe, it, expect, vi } from 'vitest';

/**
 * Regression: a cold-start `/mcp` / `/skills` (tab open, no message sent yet)
 * used to print "Session not initialized yet — send a message first." Unlike
 * Claude, creating the Copilot session directly fires the skills_loaded /
 * mcp_servers_loaded events, so `ensureLoadedContext` just ensures the session
 * exists and awaits those events. The fake session fires both on registration.
 */

const h = vi.hoisted(() => ({
  skills: [{ name: 'my-skill', description: 'd' }] as any[],
  servers: [{ name: 'shelf', status: 'connected' }] as any[],
  fireEvents: true,
}));

vi.mock('fs', () => ({ existsSync: () => true }));

vi.mock('@github/copilot-sdk', () => {
  function makeSession() {
    return {
      sessionId: 'cs1',
      on(cb: (e: any) => void) {
        if (!h.fireEvents) return;
        // Fire after registration so the waiter (pushed in ensureLoadedContext
        // right after ensureSession resolves) is in place to be settled.
        setTimeout(() => {
          cb({ type: 'session.skills_loaded', data: { skills: h.skills } });
          cb({ type: 'session.mcp_servers_loaded', data: { servers: h.servers } });
        }, 0);
      },
      registerElicitationHandler() { /* noop */ },
      rpc: { mode: { set: async () => {} } },
      sendAndWait: async () => {},
      abort: async () => {},
      disconnect() { /* noop */ },
    };
  }
  return {
    CopilotClient: class {
      async start() { /* noop */ }
      async getAuthStatus() { return { isAuthenticated: true }; }
      async listModels() { return [{ id: 'gpt-5.5', name: 'GPT-5.5', supportedReasoningEfforts: [] }]; }
      async createSession() { return makeSession(); }
      async resumeSession() { return makeSession(); }
      async stop() { /* noop */ }
    },
    defineTool: (name: string) => ({ name }),
  };
});

import { createCopilotBackend } from './index';

function collect() {
  const msgs: any[] = [];
  return { msgs, send: (m: any) => { msgs.push(m); } };
}
const replyOf = (msgs: any[]) => msgs.find((m) => m.type === 'message' && m.msgType === 'reply');

describe('copilot /mcp /skills cold-start warm', () => {
  it('cold /mcp creates the session and reports the loaded servers', async () => {
    h.fireEvents = true;
    const backend = createCopilotBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    const reply = replyOf(msgs);
    expect(reply).toBeDefined();
    expect(reply.content).toContain('shelf');
    expect(reply.content).not.toMatch(/not initialized|send a message first|Could not load/i);
  });

  it('cold /skills reports the loaded skills', async () => {
    h.fireEvents = true;
    const backend = createCopilotBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/skills', cwd: '/tmp' } as any, send);
    expect(replyOf(msgs).content).toContain('my-skill');
  });

  // The "events never arrive → fail-loud load error" path (snapshot stays
  // undefined → "Could not load …", never "none") is symmetric with — and
  // covered by — the Claude probe-failure test; exercising it here would force a
  // real 20s timeout wait (the dynamic SDK import fights fake timers).
});
