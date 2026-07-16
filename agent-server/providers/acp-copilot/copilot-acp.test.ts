import { describe, it, expect } from 'vitest';
import type { SessionUpdate, SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from '../acp/mock-agent';
import { createCopilotAcpBackend } from './index';
import type { OutgoingMessage } from '../types';

// Copilot-shaped session state (matches F5's measured `copilot --acp` catalog):
// modes agent/plan/autopilot, model list, thought_level effort. Proves copilot
// maps through the SHARED toolkit — no copilot-specific capability code (the N=2
// layering finding: capability mapping already belongs in acp/, not per-provider).
const COPILOT_MODES = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'agent', name: 'agent' },
    { id: 'plan', name: 'plan' },
    { id: 'autopilot', name: 'autopilot' },
  ],
} as unknown as SessionModeState;

const COPILOT_CONFIG = [
  {
    category: 'model',
    type: 'select',
    currentValue: 'claude-sonnet-5',
    options: [
      { value: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { value: 'gpt-5.4', name: 'GPT-5.4' },
    ],
  },
  {
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'low' },
      { value: 'medium', name: 'medium' },
      { value: 'high', name: 'high' },
    ],
  },
] as unknown as SessionConfigOption[];

describe('acp-copilot backend (via mock ACP agent)', () => {
  it('drives a prompt turn to a reply and terminates with idle', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' }, messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' }, messageId: 'm1' },
    ];
    let promptSeen: unknown;
    const mock = createMockAcpAgent({ updatesOnPrompt: updates, onPrompt: (p) => { promptSeen = p; } });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }) });

    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/tmp/project' }, (m) => out.push(m));

    expect(promptSeen).toBeTruthy();
    // Streamed chunks + a finalized reply assembled from them.
    expect(out).toContainEqual({ type: 'stream', msgId: 'm1', streamType: 'text', content: 'Hello ' });
    expect(out).toContainEqual({ type: 'message', msgId: 'm1', msgType: 'reply', content: 'Hello world' });
    // New session id persisted for later resume.
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'mock-session' } });
    // Turn ALWAYS ends idle (renderer spinner/queue latch depends on it).
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('maps copilot session state onto capabilities via the shared toolkit', async () => {
    const mock = createMockAcpAgent({ modes: COPILOT_MODES, configOptions: COPILOT_CONFIG });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }) });

    const caps = await backend.gatherCapabilities!('/tmp/project');

    expect(caps.models.map((m) => m.value)).toEqual(['claude-sonnet-5', 'gpt-5.4']);
    expect(caps.effortLevels.map((e) => e.value)).toEqual(['low', 'medium', 'high']);
    expect(caps.permissionModes.map((p) => p.value)).toEqual(['agent', 'plan', 'autopilot']);
    expect(caps.authRequired).toBeUndefined();

    backend.dispose();
  });

  it('acknowledges (does not drive) a config-edit turn and stays idle', async () => {
    const mock = createMockAcpAgent();
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }) });

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'model', value: 'gpt-5.4' } },
      (m) => out.push(m),
    );

    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });
});
