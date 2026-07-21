import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
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
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: 'claude-sonnet-5',
    options: [
      { value: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { value: 'gpt-5.4', name: 'GPT-5.4' },
    ],
  },
  {
    id: 'reasoning_effort',
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
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

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
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');

    expect(caps.models.map((m) => m.value)).toEqual(['claude-sonnet-5', 'gpt-5.4']);
    expect(caps.effortLevels.map((e) => e.value)).toEqual(['low', 'medium', 'high']);
    // Permission modes are the SHELF-standard set (matches native copilot), NOT
    // copilot's raw agent/plan/autopilot — parity + clean cutover.
    expect(caps.permissionModes.map((p) => p.value)).toEqual(['default', 'bypassPermissions', 'plan']);
    expect(caps.authRequired).toBeUndefined();
    // Current selections ride along so the status bar shows the active values;
    // the permission mode is mapped copilot#agent → Shelf 'default'.
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('claude-sonnet-5');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('medium');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBe('default');

    backend.dispose();
  });

  it('surfaces slash commands from available_commands_update in capabilities', async () => {
    const mock = createMockAcpAgent({
      commandsOnNewSession: [
        { name: 'compact', description: 'Summarize conversation' },
        { name: 'review', description: 'Review changes' },
      ],
    });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');
    expect(caps.slashCommands).toEqual([
      { name: 'compact', description: 'Summarize conversation' },
      { name: 'review', description: 'Review changes' },
    ]);

    backend.dispose();
  });

  it('declares its skill scan target as $COPILOT_HOME/skills (agent-server projects there)', () => {
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: createMockAcpAgent() }), getShelfMcp: async () => null });
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'copilot', 'skills'));
    expect(backend.skillTarget!(undefined)).toBeUndefined();
    backend.dispose();
  });

  it('does NOT recreate the session when appId is already known at caps time', async () => {
    let newSessions = 0;
    const mock = createMockAcpAgent({ onNewSession: () => { newSessions += 1; } });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    // appId now rides caps (6th arg) → the caps-time spawn already has the right
    // COPILOT_HOME, so a same-appId turn reuses the session (no wasteful recreate).
    await backend.gatherCapabilities!('/tmp/project', undefined, undefined, undefined, undefined, 'app-1');
    expect(newSessions).toBe(1);
    await backend.query({ prompt: 'hi', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(newSessions).toBe(1);

    backend.dispose();
  });

  it('respawns the CONNECTION when appId changes (COPILOT_HOME is fixed at spawn)', async () => {
    // Fresh mock per spawn — a respawn = a brand-new connection, so we count
    // openAgent calls (process spawns), not session/new. COPILOT_HOME is process
    // env, so a different appId REQUIRES a new process, not just a new session.
    let spawns = 0;
    const openAgent = () => { spawns += 1; return { target: createMockAcpAgent() }; };
    const backend = createCopilotAcpBackend({ openAgent, getShelfMcp: async () => null });

    // Legacy path: caps with NO appId → spawn 1 (default COPILOT_HOME).
    await backend.gatherCapabilities!('/tmp/project');
    expect(spawns).toBe(1);
    // First turn learns appId → respawn so the process gets the per-app COPILOT_HOME.
    await backend.query({ prompt: 'hi', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(spawns).toBe(2);
    // Same appId → reuse, no further respawn.
    await backend.query({ prompt: 'again', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(spawns).toBe(2);

    backend.dispose();
  });

  it('applies a model config-edit via session/set_config_option + acks', async () => {
    let setConfig: { configId?: string; value?: string } | undefined;
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES, configOptions: COPILOT_CONFIG,
      onSetConfigOption: (p) => { setConfig = p as typeof setConfig; },
    });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'model', value: 'gpt-5.4' } },
      (m) => out.push(m),
    );

    // Applied through ACP with the right option id + value.
    expect(setConfig?.configId).toBe('model');
    expect(setConfig?.value).toBe('gpt-5.4');
    // Updated capabilities + an ack divider, then idle.
    expect(out.some((m) => m.type === 'capabilities')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('applies a permission-mode config-edit via session/set_mode (Shelf → copilot id)', async () => {
    let setMode: { modeId?: string } | undefined;
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES, configOptions: COPILOT_CONFIG,
      onSetMode: (p) => { setMode = p as typeof setMode; },
    });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'permissionMode', value: 'bypassPermissions' } },
      (m) => out.push(m),
    );

    // Shelf 'bypassPermissions' → copilot 'autopilot' mode id.
    expect(setMode?.modeId).toBe('autopilot');
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('no-ops a config-edit that re-picks the current value', async () => {
    const mock = createMockAcpAgent({ modes: COPILOT_MODES, configOptions: COPILOT_CONFIG });
    const backend = createCopilotAcpBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    // Seed current model = claude-sonnet-5 via gatherCapabilities.
    await backend.gatherCapabilities!('/tmp/project');

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'model', value: 'claude-sonnet-5' } },
      (m) => out.push(m),
    );

    // No capabilities / ack (nothing changed) — only the terminal idle.
    expect(out.some((m) => m.type === 'capabilities')).toBe(false);
    expect(out).toEqual([{ type: 'status', state: 'idle' }]);

    backend.dispose();
  });
});
