import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
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
    { id: 'read-only', name: 'Read-only' },
    { id: 'agent', name: 'Agent' },
    { id: 'agent-full-access', name: 'Agent (full access)' },
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
    // Permission modes are codex's 3 native modes MAPPED to Shelf vocabulary in
    // canonical order (read-only→plan, agent→default, agent-full-access→bypass).
    expect(caps.permissionModes.map((p) => p.value)).toEqual(['default', 'plan', 'bypassPermissions']);
    // current-selection reported so the status bar shows the active values; the
    // permission mode is mapped codex#agent → Shelf 'default'.
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('gpt-5-codex');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('medium');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBe('default');

    backend.dispose();
  });

  it('applies a model config-edit via session/set_config_option + acks', async () => {
    let setConfig: { configId?: string; value?: string } | undefined;
    const mock = createMockAcpAgent({
      modes: CODEX_MODES, configOptions: CODEX_CONFIG,
      onSetConfigOption: (p) => { setConfig = p as typeof setConfig; },
    });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'model', value: 'o4-mini' } },
      (m) => out.push(m),
    );

    expect(setConfig?.configId).toBe('model');
    expect(setConfig?.value).toBe('o4-mini');
    expect(out.some((m) => m.type === 'capabilities')).toBe(true);
    expect(out.some((m) => m.type === 'message' && m.msgType === 'system')).toBe(true);
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('applies a permission-mode config-edit via session/set_mode (Shelf → codex id)', async () => {
    let setMode: { modeId?: string } | undefined;
    const mock = createMockAcpAgent({
      modes: CODEX_MODES, configOptions: CODEX_CONFIG,
      onSetMode: (p) => { setMode = p as typeof setMode; },
    });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'permissionMode', value: 'bypassPermissions' } },
      (m) => out.push(m),
    );

    // Shelf 'bypassPermissions' → codex 'agent-full-access' mode id.
    expect(setMode?.modeId).toBe('agent-full-access');
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('no-ops a config-edit that re-picks the current value', async () => {
    const mock = createMockAcpAgent({ modes: CODEX_MODES, configOptions: CODEX_CONFIG });
    const backend = createCodexBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    await backend.gatherCapabilities!('/tmp/project'); // seeds current model = gpt-5-codex

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'model', value: 'gpt-5-codex' } },
      (m) => out.push(m),
    );

    expect(out.some((m) => m.type === 'capabilities')).toBe(false);
    expect(out).toEqual([{ type: 'status', state: 'idle' }]);

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

  it('declares its skill scan target as <root>/.agents/skills (codex-acp convention)', () => {
    const backend = createCodexBackend({ openAgent: () => ({ target: createMockAcpAgent() }), getShelfMcp: async () => null });
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex', '.agents', 'skills'));
    expect(backend.skillTarget!(undefined)).toBeUndefined();
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

  it('respawns the CONNECTION when appId changes (CODEX_HOME is fixed at spawn)', async () => {
    // Fresh mock per spawn — a respawn = a new process, so count openAgent calls.
    // CODEX_HOME is process env, so a different appId REQUIRES a new process.
    let spawns = 0;
    const openAgent = () => { spawns += 1; return { target: createMockAcpAgent() }; };
    const backend = createCodexBackend({ openAgent, getShelfMcp: async () => null });

    await backend.gatherCapabilities!('/tmp/project'); // no appId → spawn 1 (default CODEX_HOME)
    expect(spawns).toBe(1);
    await backend.query({ prompt: 'hi', cwd: '/tmp/project', appId: 'app-1' }, () => {}); // appId → respawn
    expect(spawns).toBe(2);
    await backend.query({ prompt: 'again', cwd: '/tmp/project', appId: 'app-1' }, () => {}); // same → reuse
    expect(spawns).toBe(2);

    backend.dispose();
  });

  it('unauthenticated caps carry an oauth authMethod (AuthPane Login button, Gap A)', async () => {
    // A caps probe that can't reach a session (here: the spawn throws) is treated
    // as unauthenticated. WITHOUT authMethod the AuthPane (gated on
    // authMethod.kind === 'oauth') renders no Login button, so device-code login
    // can't start. codex advertises both api-key + chat-gpt ACP methods; the
    // backend declares the device-code (oauth) path it actually drives.
    const backend = createCodexBackend({
      openAgent: () => { throw new Error('spawn failed'); },
      getShelfMcp: async () => null,
    });

    const caps = await backend.gatherCapabilities!('/tmp/project');
    expect(caps.authRequired).toBe(true);
    expect((caps.authMethod as { kind?: string } | undefined)?.kind).toBe('oauth');

    backend.dispose();
  });

  it('declares its config-home as ~/.shelf/apps/<appId>/codex (agent-server mkdirs it, Gap B)', () => {
    // codex-acp errors if CODEX_HOME does not pre-exist; the agent-server creates
    // this declared path before spawning (provider does no fs). Same dir as the
    // CODEX_HOME env — auth/config/sessions live here. Undefined without app context.
    const backend = createCodexBackend({ openAgent: () => ({ target: createMockAcpAgent() }), getShelfMcp: async () => null });
    expect(backend.configHome!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'));
    expect(backend.configHome!(undefined)).toBeUndefined();
    backend.dispose();
  });

  it('reconnect() drops the live connection so the next turn respawns (post-login re-init, Gap C)', async () => {
    // Fresh mock per spawn — a respawn = a new process. reconnect() must drop
    // conn+child+session so the next turn re-reads the CODEX_HOME credentials a
    // device-code login just wrote (a running codex-acp spawned pre-login won't).
    let spawns = 0;
    const openAgent = () => { spawns += 1; return { target: createMockAcpAgent() }; };
    const backend = createCodexBackend({ openAgent, getShelfMcp: async () => null });

    await backend.query({ prompt: 'hi', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(spawns).toBe(1);
    // Same cwd+appId → normally reuses the process (no respawn).
    await backend.query({ prompt: 'again', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(spawns).toBe(1);
    // reconnect() drops the connection → the next turn respawns (fresh, authed).
    backend.reconnect!();
    await backend.query({ prompt: 'post-login', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(spawns).toBe(2);

    backend.dispose();
  });
});
