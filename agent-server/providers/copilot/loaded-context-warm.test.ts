import { describe, it, expect, vi } from 'vitest';

/**
 * Regression: a cold-start `/mcp` / `/skills` (tab open, no message sent yet).
 * The skills_loaded / mcp_servers_loaded events fire on the first TURN, not on
 * bare session creation — so in the cold-start window they never arrive and the
 * card used to fail ("the session failed to initialize"). The fix PULLS the
 * listings via the session RPC (`mcp.list()` / `skills.list()`). The fake
 * session below deliberately fires NO events and only answers the RPC pulls.
 */

const h = vi.hoisted(() => ({
  skills: [{ name: 'my-skill', description: 'd', source: 'custom' }] as any[],
  servers: [{ name: 'playwright', status: 'connected', source: 'user' }] as any[],
  rpcThrows: false,
}));

vi.mock('fs', () => ({ existsSync: () => true }));

vi.mock('@github/copilot-sdk', () => {
  function makeSession() {
    return {
      sessionId: 'cs1',
      on(_cb: (e: any) => void) { /* no events in the cold-start window */ },
      registerElicitationHandler() { /* noop */ },
      rpc: {
        mode: { set: async () => {} },
        mcp: { list: async () => { if (h.rpcThrows) throw new Error('rpc down'); return { servers: h.servers }; } },
        skills: { list: async () => { if (h.rpcThrows) throw new Error('rpc down'); return { skills: h.skills }; } },
      },
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
    RuntimeConnection: { forStdio: (opts: any) => ({ kind: 'stdio', ...opts }) },
  };
});

import { createCopilotBackend } from './index';

function collect() {
  const msgs: any[] = [];
  return { msgs, send: (m: any) => { msgs.push(m); } };
}
const replyOf = (msgs: any[]) => msgs.find((m) => m.type === 'message' && m.msgType === 'reply');

describe('copilot /mcp /skills cold-start warm (RPC pull)', () => {
  it('cold /mcp pulls real servers AND surfaces the in-process shelf bridge with its tools', async () => {
    h.rpcThrows = false;
    const backend = createCopilotBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    const reply = replyOf(msgs);
    expect(reply).toBeDefined();
    expect(reply.content).toContain('| `playwright` |');           // real server from rpc.mcp.list()
    expect(reply.content).toContain('| `shelf` |');                // appended in-process bridge
    expect(reply.content).toContain('| `list_app_skills` | `shelf` |'); // a bridge tool in the tools table
    expect(reply.content).not.toMatch(/not initialized|Could not load|failed to initialize/i);
  });

  it('cold /skills pulls via rpc.skills.list()', async () => {
    h.rpcThrows = false;
    const backend = createCopilotBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/skills', cwd: '/tmp' } as any, send);
    expect(replyOf(msgs).content).toContain('my-skill');
  });

  it('real-server pull throws → fail-loud note, but the shelf bridge still shows', async () => {
    h.rpcThrows = true;
    const backend = createCopilotBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    const content = replyOf(msgs).content;
    expect(content).toMatch(/Could not load configured MCP servers/i);  // fail-loud
    expect(content).toContain('| `shelf` |');                           // bridge never hidden
  });
});
