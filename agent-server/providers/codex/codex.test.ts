import { describe, it, expect } from 'vitest';
import type { SessionUpdate, SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from '../acp/mock-agent';
import { createCodexBackend } from './index';
import type { OutgoingMessage } from '../types';

// Codex-shaped session state (model + thought_level config options, a couple of
// modes). Proves codex maps through the SAME shared toolkit as copilot-acp — the
// N=2 hardening thesis: capability mapping belongs in acp/, not per-provider.
const CODEX_MODES = {
  currentModeId: 'agent',
  availableModes: [
    { id: 'agent', name: 'Agent' },
    { id: 'read-only', name: 'Read Only' },
  ],
} as unknown as SessionModeState;

const CODEX_CONFIG = [
  {
    id: 'model', category: 'model', type: 'select', currentValue: 'gpt-5-codex',
    options: [
      { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
      { value: 'o4-mini', name: 'o4-mini' },
    ],
  },
  {
    id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'medium',
    options: [
      { value: 'low', name: 'low' },
      { value: 'medium', name: 'medium' },
      { value: 'high', name: 'high' },
    ],
  },
] as unknown as SessionConfigOption[];

describe('codex backend (via mock ACP agent)', () => {
  it('drives a prompt turn to a reply and terminates with idle', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi ' }, messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'there' }, messageId: 'm1' },
    ];
    const mock = createMockAcpAgent({ updatesOnPrompt: updates });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/tmp/project' }, (m) => out.push(m));

    expect(out).toContainEqual({ type: 'message', msgId: 'm1', msgType: 'reply', content: 'Hi there' });
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'mock-session' } });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('maps codex session state onto capabilities WITH current selections', async () => {
    const mock = createMockAcpAgent({ modes: CODEX_MODES, configOptions: CODEX_CONFIG });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');

    expect(caps.models.map((m) => m.value)).toEqual(['gpt-5-codex', 'o4-mini']);
    expect(caps.effortLevels.map((e) => e.value)).toEqual(['low', 'medium', 'high']);
    // The gap this closes: current-selection is now reported so the status bar
    // shows the active model/effort/mode (was empty with plain mapSessionCapabilities).
    // Permission mode is codex's RAW mode id for now (Shelf-semantic mapping = T4.1-A).
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('gpt-5-codex');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('medium');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBe('agent');

    backend.dispose();
  });

  it('surfaces slash commands from available_commands_update', async () => {
    const mock = createMockAcpAgent({
      commandsOnNewSession: [{ name: 'init', description: 'Initialize the workspace' }],
    });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');
    expect(caps.slashCommands).toEqual([{ name: 'init', description: 'Initialize the workspace' }]);

    backend.dispose();
  });

  it('includes the shelf MCP bridge (L1) in session/new mcpServers', async () => {
    let newParams: { mcpServers?: unknown } | undefined;
    const mock = createMockAcpAgent({ onNewSession: (p) => { newParams = p as typeof newParams; } });
    const backend = createCodexBackend({
      openAgent: () => ({ target: mock }),
      getShelfMcp: async () => ({ url: 'http://127.0.0.1:9/mcp' }),
    });

    await backend.gatherCapabilities!('/tmp/project');
    expect(newParams?.mcpServers).toContainEqual({ type: 'http', name: 'shelf', url: 'http://127.0.0.1:9/mcp', headers: [] });

    backend.dispose();
  });

  it('forwards images through the prompt turn', async () => {
    let promptParams: { prompt?: Array<{ type: string }> } | undefined;
    const mock = createMockAcpAgent({ onPrompt: (p) => { promptParams = p as typeof promptParams; } });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    await backend.query(
      { prompt: 'see', cwd: '/tmp/project', images: ['data:image/png;base64,AAAA'] },
      () => {},
    );
    const kinds = (promptParams?.prompt ?? []).map((b) => b.type);
    expect(kinds).toContain('image');

    backend.dispose();
  });
});
