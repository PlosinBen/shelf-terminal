import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: a `/mcp` or `/skills` slash run in the COLD-START window — tab
 * opened, no message sent yet, so no real session exists — used to print
 * "Session not initialized yet — send a message first." The streaming-input
 * persistent session emits no `system/init` until a message is pushed, so
 * `ensureLoadedContext` spins a throwaway string-prompt probe (which DOES init)
 * to fill the cache on demand. These tests mock the SDK so the probe is driven
 * deterministically.
 */

const sdkQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => sdkQueryMock(...args),
  tool: (name: string) => ({ name }),
  createSdkMcpServer: (cfg: any) => cfg,
}));

import { createClaudeBackend } from './index';

const INIT = { type: 'system', subtype: 'init', session_id: 's1' };

/** A throwaway-probe Query: yields init, then exposes the control methods
 *  ensureLoadedContext reads. Code after `yield` never runs — the consumer
 *  breaks right after init, so the generator is abandoned (no hang). */
function fakeProbeQuery(opts: { servers?: any[]; commands?: any[] } = {}) {
  async function* gen() {
    yield INIT;
  }
  const it: any = gen();
  it.mcpServerStatus = async () => opts.servers ?? [];
  it.supportedCommands = async () => opts.commands ?? [];
  return it;
}

function collect() {
  const msgs: any[] = [];
  return { msgs, send: (m: any) => { msgs.push(m); } };
}

const replyOf = (msgs: any[]) => msgs.find((m) => m.type === 'message' && m.msgType === 'reply');

describe('claude /mcp /skills cold-start warm', () => {
  beforeEach(() => sdkQueryMock.mockReset());

  it('cold /mcp warms the cache via a throwaway probe (no "send a message first")', async () => {
    sdkQueryMock.mockImplementation(() => fakeProbeQuery({ servers: [{ name: 'shelf', status: 'connected' }] }));
    const backend = createClaudeBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    const reply = replyOf(msgs);
    expect(reply).toBeDefined();
    expect(reply.content).toContain('shelf');
    expect(reply.content).not.toMatch(/not initialized|send a message first|Could not load/i);
  });

  it('cold /skills warms via the probe and filters built-in commands', async () => {
    sdkQueryMock.mockImplementation(() =>
      fakeProbeQuery({ commands: [{ name: 'my-skill', description: 'd' }, { name: 'clear' }] }),
    );
    const backend = createClaudeBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/skills', cwd: '/tmp' } as any, send);
    const reply = replyOf(msgs);
    expect(reply.content).toContain('my-skill');
    expect(reply.content).not.toContain('clear');
  });

  it('second /mcp reuses the warmed cache — no second probe', async () => {
    sdkQueryMock.mockImplementation(() => fakeProbeQuery({ servers: [{ name: 'shelf', status: 'connected' }] }));
    const backend = createClaudeBackend();
    const { send } = collect();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    expect(sdkQueryMock).toHaveBeenCalledTimes(1);
  });

  it('probe fails (no init) → fail-loud load error, never claims "none"', async () => {
    // Generator ends without ever yielding init → cache stays unset.
    sdkQueryMock.mockImplementation(() => {
      async function* gen() { /* no init */ }
      const it: any = gen();
      it.mcpServerStatus = async () => [];
      it.supportedCommands = async () => [];
      return it;
    });
    const backend = createClaudeBackend();
    const { msgs, send } = collect();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' } as any, send);
    expect(replyOf(msgs).content).toMatch(/Could not load/i);
  });
});
