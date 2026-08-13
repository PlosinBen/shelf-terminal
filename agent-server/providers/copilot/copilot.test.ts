import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import { createMockAcpAgent } from '../acp/mock-agent';
import { createCopilotBackend } from './index';
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
  {
    id: 'allow_all',
    name: 'Allow all',
    description: 'Allow all tool permissions',
    category: 'permissions',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'off', name: 'Off', description: 'Ask before protected tools' },
      { value: 'on', name: 'On', description: 'Allow protected tools' },
    ],
  },
] as unknown as SessionConfigOption[];

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
];

describe('acp-copilot backend (via mock ACP agent)', () => {
  it('confirms stop only when the active ACP prompt returns cancelled', async () => {
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    let cancelParams: unknown;
    const mock = createMockAcpAgent({
      waitForCancelOnPrompt: true,
      stopReason: 'cancelled',
      onPrompt: () => promptStarted(),
      onCancel: (params) => { cancelParams = params; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const queryDone = backend.query({ prompt: 'keep working', cwd: '/tmp/project' }, () => {});
    await started;
    await expect(backend.stop()).resolves.toBeUndefined();
    await queryDone;

    expect(cancelParams).toEqual({ sessionId: 'mock-session' });
    backend.dispose();
  });

  it('fails stop when Copilot settles the cancelled prompt with a different reason', async () => {
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const mock = createMockAcpAgent({
      waitForCancelOnPrompt: true,
      stopReason: 'end_turn',
      onPrompt: () => promptStarted(),
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const queryDone = backend.query({ prompt: 'keep working', cwd: '/tmp/project' }, () => {});
    await started;
    await expect(backend.stop()).rejects.toThrow('expected cancelled, received end_turn');
    await queryDone;

    backend.dispose();
  });

  it('still sends session/cancel after the prompt response has settled', async () => {
    let cancelParams: unknown;
    let connectionCount = 0;
    const mock = createMockAcpAgent({
      onCancel: (params) => { cancelParams = params; },
    });
    const backend = createCopilotBackend({
      openAgent: () => { connectionCount++; return { target: mock }; },
      getShelfMcp: async () => null,
    });

    await backend.query({ prompt: 'start autopilot work', cwd: '/tmp/project' }, () => {});
    await expect(backend.stop()).resolves.toBeUndefined();
    await backend.query({ prompt: 'resume after forced stop', cwd: '/tmp/project' }, () => {});

    expect(cancelParams).toEqual({ sessionId: 'mock-session' });
    expect(connectionCount).toBe(2);
    backend.dispose();
  });

  it('forwards prompt text deltas and terminates with idle', async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' }, messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' }, messageId: 'm1' },
    ];
    let promptSeen: unknown;
    const mock = createMockAcpAgent({ updatesOnPrompt: updates, onPrompt: (p) => { promptSeen = p; } });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/tmp/project' }, (m) => out.push(m));

    expect(promptSeen).toBeTruthy();
    // Text is a delta stream; the renderer is the sole accumulator/finalizer.
    expect(out).toContainEqual({ type: 'stream', msgId: 'm1', streamType: 'text', content: 'Hello ' });
    expect(out).toContainEqual({ type: 'stream', msgId: 'm1', streamType: 'text', content: 'world' });
    expect(out).not.toContainEqual(expect.objectContaining({ type: 'message', msgId: 'm1', msgType: 'reply' }));
    // New session id persisted for later resume.
    expect(out).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'mock-session' } });
    // Turn ALWAYS ends idle (renderer spinner/queue latch depends on it).
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('exposes separate provider-native mode and permission controls', async () => {
    const mock = createMockAcpAgent({ modes: COPILOT_MODES, configOptions: COPILOT_CONFIG });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');

    expect(caps.models.map((m) => m.value)).toEqual(['claude-sonnet-5', 'gpt-5.4']);
    expect(caps.effortLevels.map((e) => e.value)).toEqual(['low', 'medium', 'high']);
    expect(caps.permissionModes).toEqual([]);
    expect(caps.permissionControl).toEqual({
      strategy: 'native',
      mode: {
        label: 'Mode',
        currentValue: 'agent',
        options: [
          { value: 'agent', displayName: 'agent' },
          { value: 'plan', displayName: 'plan' },
          { value: 'autopilot', displayName: 'autopilot' },
        ],
      },
      permission: {
        label: 'Allow all',
        description: 'Allow all tool permissions',
        currentValue: 'off',
        options: [
          { value: 'off', displayName: 'Off', description: 'Ask before protected tools' },
          { value: 'on', displayName: 'On', description: 'Allow protected tools' },
        ],
      },
    });
    expect(caps.authRequired).toBeUndefined();
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('claude-sonnet-5');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('medium');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBeUndefined();

    backend.dispose();
  });

  it('surfaces slash commands from available_commands_update in capabilities', async () => {
    const mock = createMockAcpAgent({
      commandsOnNewSession: [
        { name: 'compact', description: 'Summarize conversation' },
        { name: 'review', description: 'Review changes' },
      ],
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');
    expect(caps.slashCommands).toEqual([
      { name: 'compact', description: 'Summarize conversation' },
      { name: 'review', description: 'Review changes' },
    ]);

    backend.dispose();
  });

  it('declares its skill scan target as $COPILOT_HOME/skills (agent-server projects there)', () => {
    const backend = createCopilotBackend({ openAgent: () => ({ target: createMockAcpAgent() }), getShelfMcp: async () => null });
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'copilot', 'skills'));
    expect(backend.skillTarget!(undefined)).toBeUndefined();
    backend.dispose();
  });

  it('does NOT recreate the session when appId is already known at caps time', async () => {
    let newSessions = 0;
    const mock = createMockAcpAgent({ onNewSession: () => { newSessions += 1; } });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    // appId now rides caps (6th arg) → the caps-time spawn already has the right
    // COPILOT_HOME, so a same-appId turn reuses the session (no wasteful recreate).
    await backend.gatherCapabilities!('/tmp/project', undefined, undefined, undefined, undefined, 'app-1');
    expect(newSessions).toBe(1);
    await backend.query({ prompt: 'hi', cwd: '/tmp/project', appId: 'app-1' }, () => {});
    expect(newSessions).toBe(1);

    backend.dispose();
  });

  it('resumes persisted ACP state before capability discovery creates a new session', async () => {
    let newSessions = 0;
    let resumedSessionId: string | undefined;
    let promptSessionId: string | undefined;
    const mock = createMockAcpAgent({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      modes: COPILOT_MODES,
      configOptions: COPILOT_CONFIG,
      commandsOnResumeSession: [{ name: 'compact', description: 'Summarize conversation' }],
      onNewSession: () => { newSessions += 1; },
      onResumeSession: (params) => { resumedSessionId = (params as { sessionId?: string }).sessionId; },
      onPrompt: (params) => { promptSessionId = (params as { sessionId?: string }).sessionId; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!(
      '/tmp/project',
      'shelf-session',
      undefined,
      { permissionMode: 'bypassPermissions' },
      undefined,
      'app-1',
      {
        sessionId: 'shelf-session',
        provider: 'copilot',
        updatedAt: 1,
        lastSdkSessionId: 'persisted-acp-session',
      },
    );

    expect(resumedSessionId).toBe('persisted-acp-session');
    expect(newSessions).toBe(0);
    expect(caps.permissionControl).toMatchObject({
      strategy: 'native',
      mode: { currentValue: 'agent' },
      permission: { currentValue: 'off' },
    });
    expect(caps.slashCommands).toEqual([{ name: 'compact', description: 'Summarize conversation' }]);
    await backend.query({
      prompt: 'continue the restored conversation',
      cwd: '/tmp/project',
      appId: 'app-1',
      restoreContext: {
        sessionId: 'shelf-session',
        provider: 'copilot',
        updatedAt: 1,
        lastSdkSessionId: 'persisted-acp-session',
      },
    }, () => {});
    expect(promptSessionId).toBe('persisted-acp-session');
    expect(newSessions).toBe(0);
    backend.dispose();
  });

  it('publishes the native session pointer when capability discovery starts a fresh session', async () => {
    let newSessions = 0;
    let promptSessionId: string | undefined;
    const mock = createMockAcpAgent({
      sessionId: 'fresh-acp-session',
      onNewSession: () => { newSessions += 1; },
      onPrompt: (params) => { promptSessionId = (params as { sessionId?: string }).sessionId; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    const sessionOut: OutgoingMessage[] = [];
    backend.bindSessionSend!((message) => sessionOut.push(message));

    await backend.gatherCapabilities!('/tmp/project', 'shelf-session', undefined, undefined, undefined, 'app-1');
    await backend.query({ prompt: 'first prompt', cwd: '/tmp/project', appId: 'app-1' }, () => {});

    expect(newSessions).toBe(1);
    expect(promptSessionId).toBe('fresh-acp-session');
    expect(sessionOut).toContainEqual({
      type: 'context_patch',
      patch: { lastSdkSessionId: 'fresh-acp-session' },
    });
    backend.dispose();
  });

  it('fails loud without starting a replacement session when resume is rejected', async () => {
    let newSessions = 0;
    const mock = createMockAcpAgent({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      resumeSessionError: 'resume transport failed',
      onNewSession: () => { newSessions += 1; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    await expect(backend.gatherCapabilities!(
      '/tmp/project',
      'shelf-session',
      undefined,
      undefined,
      undefined,
      'app-1',
      {
        sessionId: 'shelf-session',
        provider: 'copilot',
        updatedAt: 1,
        lastSdkSessionId: 'persisted-acp-session',
      },
    )).rejects.toThrow('resume transport failed');
    expect(newSessions).toBe(0);
    backend.dispose();
  });

  it('starts a fresh session when the persisted Copilot session no longer exists', async () => {
    let newSessions = 0;
    const mock = createMockAcpAgent({
      sessionId: 'fresh-acp-session',
      loadSessionError: 'Resource not found: Session persisted-acp-session not found',
      onNewSession: () => { newSessions += 1; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    const sessionOut: OutgoingMessage[] = [];
    backend.bindSessionSend!((message) => sessionOut.push(message));

    await expect(backend.gatherCapabilities!(
      '/tmp/project',
      'shelf-session',
      undefined,
      undefined,
      undefined,
      'app-1',
      {
        sessionId: 'shelf-session',
        provider: 'copilot',
        updatedAt: 1,
        lastSdkSessionId: 'persisted-acp-session',
      },
    )).resolves.toMatchObject({ permissionControl: { strategy: 'native' } });

    expect(newSessions).toBe(1);
    expect(sessionOut).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: null } });
    expect(sessionOut).toContainEqual({ type: 'context_patch', patch: { lastSdkSessionId: 'fresh-acp-session' } });
    expect(sessionOut).toContainEqual(expect.objectContaining({
      type: 'message',
      msgType: 'system',
      content: 'Previous Copilot session was unavailable; started a new session.',
    }));
    backend.dispose();
  });

  it('loads legacy Copilot sessions without replaying duplicate conversation content', async () => {
    let loadedSessionId: string | undefined;
    let resumeRequests = 0;
    let newSessions = 0;
    let promptSessionId: string | undefined;
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES,
      configOptions: COPILOT_CONFIG,
      updatesOnLoadSession: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replayed answer' }, messageId: 'old-1' },
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: 'Summarize conversation' }],
        },
      ],
      onLoadSession: (params) => { loadedSessionId = (params as { sessionId?: string }).sessionId; },
      onResumeSession: () => { resumeRequests += 1; },
      onNewSession: () => { newSessions += 1; },
      onPrompt: (params) => { promptSessionId = (params as { sessionId?: string }).sessionId; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    const sessionOut: OutgoingMessage[] = [];
    backend.bindSessionSend!((message) => sessionOut.push(message));
    const restoreContext = {
      sessionId: 'shelf-session',
      provider: 'copilot' as const,
      updatedAt: 1,
      lastSdkSessionId: 'persisted-acp-session',
    };

    const caps = await backend.gatherCapabilities!(
      '/tmp/project', 'shelf-session', undefined, undefined, undefined, 'app-1', restoreContext,
    );
    await backend.query({
      prompt: 'continue after load', cwd: '/tmp/project', appId: 'app-1', restoreContext,
    }, () => {});

    expect(loadedSessionId).toBe('persisted-acp-session');
    expect(resumeRequests).toBe(0);
    expect(newSessions).toBe(0);
    expect(promptSessionId).toBe('persisted-acp-session');
    expect(sessionOut).not.toContainEqual(expect.objectContaining({ type: 'stream', content: 'old replayed answer' }));
    expect(caps.slashCommands).toEqual([{ name: 'compact', description: 'Summarize conversation' }]);
    expect(caps.permissionControl).toMatchObject({
      strategy: 'native',
      mode: { currentValue: 'agent' },
      permission: { currentValue: 'off' },
    });
    backend.dispose();
  });

  it('fails before resume when Copilot advertises neither stable nor legacy session restore support', async () => {
    let resumeRequests = 0;
    let newSessions = 0;
    const mock = createMockAcpAgent({
      agentCapabilities: {},
      onResumeSession: () => { resumeRequests += 1; },
      onNewSession: () => { newSessions += 1; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    await expect(backend.gatherCapabilities!(
      '/tmp/project',
      'shelf-session',
      undefined,
      undefined,
      undefined,
      'app-1',
      {
        sessionId: 'shelf-session',
        provider: 'copilot',
        updatedAt: 1,
        lastSdkSessionId: 'persisted-acp-session',
      },
    )).rejects.toThrow('does not advertise session restore support');
    expect(resumeRequests).toBe(0);
    expect(newSessions).toBe(0);
    backend.dispose();
  });

  it('respawns the CONNECTION when appId changes (COPILOT_HOME is fixed at spawn)', async () => {
    // Fresh mock per spawn — a respawn = a brand-new connection, so we count
    // openAgent calls (process spawns), not session/new. COPILOT_HOME is process
    // env, so a different appId REQUIRES a new process, not just a new session.
    let spawns = 0;
    const openAgent = () => { spawns += 1; return { target: createMockAcpAgent() }; };
    const backend = createCopilotBackend({ openAgent, getShelfMcp: async () => null });

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
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

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

  it('applies native mode and permission edits through their independent ACP methods', async () => {
    let setMode: { modeId?: string } | undefined;
    let setConfig: { configId?: string; value?: string } | undefined;
    const permissionOn = COPILOT_CONFIG.map((option) => (
      option.id === 'allow_all' && option.type === 'select' ? { ...option, currentValue: 'on' } : option
    ));
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES, configOptions: COPILOT_CONFIG,
      configOptionsOnSetConfigOption: permissionOn,
      onSetMode: (p) => { setMode = p as typeof setMode; },
      updatesOnSetMode: [{ sessionUpdate: 'current_mode_update', currentModeId: 'autopilot' }],
      onSetConfigOption: (p) => { setConfig = p as typeof setConfig; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'nativeMode', value: 'autopilot' } },
      (m) => out.push(m),
    );
    expect(setMode?.modeId).toBe('autopilot');
    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'nativePermission', value: 'on' } },
      (m) => out.push(m),
    );
    expect(setConfig).toMatchObject({ configId: 'allow_all', value: 'on' });
    expect(out).toContainEqual(expect.objectContaining({
      type: 'capabilities',
      permissionControl: expect.objectContaining({
        permission: expect.objectContaining({ currentValue: 'on' }),
      }),
    }));
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });

    backend.dispose();
  });

  it('replaces displayed native state from slash-driven ACP updates', async () => {
    const permissionOn = COPILOT_CONFIG.map((option) => (
      option.id === 'allow_all' && option.type === 'select' ? { ...option, currentValue: 'on' } : option
    ));
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES,
      configOptions: COPILOT_CONFIG,
      updatesOnPrompt: [
        { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
        { sessionUpdate: 'config_option_update', configOptions: permissionOn },
      ],
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    const sessionEvents: OutgoingMessage[] = [];
    backend.bindSessionSend!((message) => sessionEvents.push(message));

    await backend.query({ prompt: '/allow-all', cwd: '/tmp/project' }, () => {});

    expect(sessionEvents.at(-1)).toMatchObject({
      type: 'capabilities',
      permissionControl: {
        strategy: 'native',
        mode: { currentValue: 'plan' },
        permission: { currentValue: 'on' },
      },
    });
    backend.dispose();
  });

  it('omits an unadvertised native permission control without restoring a Shelf fallback', async () => {
    const configWithoutPermission = COPILOT_CONFIG.filter((option) => option.id !== 'allow_all');
    const mock = createMockAcpAgent({ modes: COPILOT_MODES, configOptions: configWithoutPermission });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const caps = await backend.gatherCapabilities!('/tmp/project');

    expect(caps.permissionModes).toEqual([]);
    expect(caps.permissionControl).toMatchObject({ strategy: 'native', mode: { currentValue: 'agent' } });
    expect(caps.permissionControl).not.toHaveProperty('permission');
    expect(backend.setPermissionMode).toBeUndefined();
    backend.dispose();
  });

  it('keeps provider truth when enterprise policy rejects allow_all', async () => {
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES,
      configOptions: COPILOT_CONFIG,
      setConfigOptionError: 'allow_all is disabled by enterprise policy',
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
    const out: OutgoingMessage[] = [];

    await backend.query(
      { prompt: '', cwd: '/tmp/project', configEdit: { key: 'nativePermission', value: 'on' } },
      (message) => out.push(message),
    );

    expect(out).toContainEqual(expect.objectContaining({
      type: 'message',
      msgType: 'error',
      content: expect.stringContaining('Failed to set nativePermission'),
    }));
    expect(out).not.toContainEqual(expect.objectContaining({
      type: 'capabilities',
      permissionControl: expect.objectContaining({
        permission: expect.objectContaining({ currentValue: 'on' }),
      }),
    }));
    backend.dispose();
  });

  it('always bridges ACP permission requests instead of auto-approving from Shelf prefs', async () => {
    let outcome: RequestPermissionResponse['outcome'] | undefined;
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES,
      configOptions: COPILOT_CONFIG,
      requestPermissionOnPrompt: {
        toolCallId: 'find-go-files',
        title: 'Find related Go files',
        options: PERMISSION_OPTIONS,
      },
      onPermissionOutcome: (value) => { outcome = value; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    await backend.gatherCapabilities!(
      '/tmp/project',
      undefined,
      undefined,
      { permissionMode: 'bypassPermissions' },
    );
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'inspect another project', cwd: '/tmp/project' }, (message) => {
      out.push(message);
      if (message.type === 'permission_request') backend.resolvePermission!(message.toolUseId, true, undefined, 'once');
    });

    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(out).toContainEqual(expect.objectContaining({ type: 'permission_request' }));

    backend.dispose();
  });

  it('continues bridging ACP permission requests in default mode', async () => {
    let outcome: RequestPermissionResponse['outcome'] | undefined;
    const mock = createMockAcpAgent({
      modes: COPILOT_MODES,
      requestPermissionOnPrompt: {
        toolCallId: 'write-file',
        title: 'Write file',
        options: PERMISSION_OPTIONS,
      },
      onPermissionOutcome: (value) => { outcome = value; },
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'edit the file', cwd: '/tmp/project' }, (message) => {
      out.push(message);
      if (message.type === 'permission_request') {
        backend.resolvePermission!(message.toolUseId, true, undefined, 'once');
      }
    });

    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(out).toContainEqual(expect.objectContaining({
      type: 'permission_request',
      toolUseId: 'write-file',
      toolName: 'Write file',
    }));

    backend.dispose();
  });

  it('no-ops a config-edit that re-picks the current value', async () => {
    const mock = createMockAcpAgent({ modes: COPILOT_MODES, configOptions: COPILOT_CONFIG });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });
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

  it('sends the ACP initialize handshake BEFORE session/new', async () => {
    // Shared acp/ toolkit change: initialize must precede session/new (spec-correct;
    // codex-acp hard-rejects otherwise, copilot --acp tolerated its absence).
    const calls: string[] = [];
    const mock = createMockAcpAgent({
      onInitialize: () => calls.push('initialize'),
      onNewSession: () => calls.push('session/new'),
    });
    const backend = createCopilotBackend({ openAgent: () => ({ target: mock }), getShelfMcp: async () => null });

    await backend.gatherCapabilities!('/tmp/project');
    expect(calls).toEqual(['initialize', 'session/new']);

    backend.dispose();
  });

  it('unauthenticated caps carry an oauth authMethod (AuthPane Login button, Gap A)', async () => {
    // A caps probe that can't reach a session (here: the spawn throws) is treated
    // as unauthenticated. WITHOUT authMethod the AuthPane (gated on
    // authMethod.kind === 'oauth') renders no Login button, so login can't start.
    const backend = createCopilotBackend({
      openAgent: () => { throw new Error('spawn failed'); },
      getShelfMcp: async () => null,
    });

    const caps = await backend.gatherCapabilities!('/tmp/project');
    expect(caps.authRequired).toBe(true);
    expect((caps.authMethod as { kind?: string } | undefined)?.kind).toBe('oauth');

    backend.dispose();
  });

  it('reconnect() drops the live connection so the next turn respawns (post-login re-init, Gap C)', async () => {
    // Fresh mock per spawn — a respawn = a new process. reconnect() must drop
    // conn+child+session so the next turn re-reads the config-home credentials a
    // device-login just wrote (a running --acp process spawned pre-login won't).
    let spawns = 0;
    const openAgent = () => { spawns += 1; return { target: createMockAcpAgent() }; };
    const backend = createCopilotBackend({ openAgent, getShelfMcp: async () => null });

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
