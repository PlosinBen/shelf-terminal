// Mock ACP agent fixture (TEST-ONLY — never imported by exec.ts, so it is
// tree-shaken out of the production agent-server bundle).
//
// A scriptable in-process ACP *agent* built on the real @agentclientprotocol/sdk,
// so the shared acp/ toolkit + the codex backend can be exercised end-to-end
// (initialize → session/new → prompt → session/update stream → permission → stop)
// with NO real codex, NO stdio, and NO credentials. This is the test enabler for
// Phase 1–2 (see acp-provider feature note, T1.0).

import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentCapabilities,
  type SessionUpdate,
  type StopReason,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionConfigOption,
  type AvailableCommand,
} from '@agentclientprotocol/sdk';

export interface MockAgentScript {
  /** Capabilities returned by initialize (default mirrors pinned Copilot's legacy resume signal). */
  agentCapabilities?: AgentCapabilities;
  /** Auth methods advertised at initialize (default: one chatgpt-like method). */
  authMethods?: Array<{ id: string; name: string; description?: string | null }>;
  /** Session id handed back from session/new (default: 'mock-session'). */
  sessionId?: string;
  /** Modes advertised in the session/new response (drives permission-mode caps). */
  modes?: SessionModeState;
  /** Config options in the session/new response (drives model/effort caps). */
  configOptions?: SessionConfigOption[];
  /** Slash commands emitted as an `available_commands_update` right after
   *  session/new (mirrors copilot, which sends them out-of-turn near session start). */
  commandsOnNewSession?: AvailableCommand[];
  /** Slash commands emitted after session/resume. */
  commandsOnResumeSession?: AvailableCommand[];
  /** Updates emitted (in order) while handling each session/prompt. */
  updatesOnPrompt?: SessionUpdate[];
  /** Stop reason returned by session/prompt (default: 'end_turn'). */
  stopReason?: StopReason;
  /** Keep session/prompt pending until the client sends session/cancel. */
  waitForCancelOnPrompt?: boolean;
  /** Called with the `initialize` params — lets a test assert the ACP handshake
   *  happened (and, via a shared recorder, that it preceded session/new). */
  onInitialize?: (params: unknown) => void;
  /** Called with each prompt's params — lets a test capture what was sent. */
  onPrompt?: (params: unknown) => void;
  /** Called when the client sends session/cancel. */
  onCancel?: (params: unknown) => void;
  /** Called with session/new params (e.g. to assert additionalDirectories). */
  onNewSession?: (params: unknown) => void;
  /** Called with session/resume params. */
  onResumeSession?: (params: unknown) => void;
  /** Reject session/resume with this message. */
  resumeSessionError?: string;
  /** Called with session/load params. */
  onLoadSession?: (params: unknown) => void;
  /** Conversation/metadata updates replayed while handling session/load. */
  updatesOnLoadSession?: SessionUpdate[];
  /** Called with session/set_mode params (assert modeId). */
  onSetMode?: (params: unknown) => void;
  /** Authoritative updates emitted while handling session/set_mode. */
  updatesOnSetMode?: SessionUpdate[];
  /** Called with session/set_config_option params (assert configId + value). */
  onSetConfigOption?: (params: unknown) => void;
  /** Full authoritative config snapshot returned by session/set_config_option. */
  configOptionsOnSetConfigOption?: SessionConfigOption[];
  /** Reject session/set_config_option (for provider policy fixtures). */
  setConfigOptionError?: string;
  /**
   * When set, the prompt handler first calls `session/request_permission` with
   * these options and reports the client's outcome via `onPermissionOutcome`.
   */
  requestPermissionOnPrompt?: { toolCallId: string; title: string; options: PermissionOption[] };
  onPermissionOutcome?: (outcome: RequestPermissionResponse['outcome']) => void;
}

/**
 * Build a mock ACP `AgentApp`. Connect a client to it in-process via
 * `client().connectWith(mockAgent, …)` or `clientApp.connect(mockAgent)`.
 */
export function createMockAcpAgent(script: MockAgentScript = {}): AgentApp {
  const sessionId = script.sessionId ?? 'mock-session';
  const authMethods = script.authMethods ?? [{ id: 'chatgpt', name: 'ChatGPT', description: 'Use ChatGPT to authenticate' }];
  const updates = script.updatesOnPrompt ?? [];
  const stopReason: StopReason = script.stopReason ?? 'end_turn';
  let releaseCancelledPrompt: (() => void) | null = null;

  return agent({ name: 'mock-acp-agent' })
    .onRequest('initialize', ({ params }) => {
      script.onInitialize?.(params);
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: script.agentCapabilities ?? {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { list: {} },
        },
        authMethods,
      };
    })
    .onRequest('session/new', async ({ params, client }) => {
      script.onNewSession?.(params);
      if (script.commandsOnNewSession) {
        await client.notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: script.commandsOnNewSession },
        });
      }
      return {
        sessionId,
        ...(script.modes ? { modes: script.modes } : {}),
        ...(script.configOptions ? { configOptions: script.configOptions } : {}),
      };
    })
    .onRequest('session/resume', async ({ params, client }) => {
      script.onResumeSession?.(params);
      if (script.resumeSessionError) throw new RequestError(-32001, script.resumeSessionError);
      if (script.commandsOnResumeSession) {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: script.commandsOnResumeSession },
        });
      }
      return {
        ...(script.modes ? { modes: script.modes } : {}),
        ...(script.configOptions ? { configOptions: script.configOptions } : {}),
      };
    })
    .onRequest('session/load', async ({ params, client }) => {
      script.onLoadSession?.(params);
      for (const update of script.updatesOnLoadSession ?? []) {
        await client.notify('session/update', { sessionId: params.sessionId, update });
      }
      return {
        ...(script.modes ? { modes: script.modes } : {}),
        ...(script.configOptions ? { configOptions: script.configOptions } : {}),
      };
    })
    .onRequest('session/set_mode', async ({ params, client }) => {
      script.onSetMode?.(params);
      for (const update of script.updatesOnSetMode ?? []) {
        await client.notify('session/update', { sessionId, update });
      }
      return {};
    })
    .onRequest('session/set_config_option', ({ params }) => {
      script.onSetConfigOption?.(params);
      if (script.setConfigOptionError) throw new Error(script.setConfigOptionError);
      // Response echoes the full config set (real agents return updated values).
      return { configOptions: script.configOptionsOnSetConfigOption ?? script.configOptions ?? [] };
    })
    .onNotification('session/cancel', ({ params }) => {
      script.onCancel?.(params);
      releaseCancelledPrompt?.();
      releaseCancelledPrompt = null;
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      script.onPrompt?.(params);
      if (script.waitForCancelOnPrompt) {
        await new Promise<void>((resolve) => { releaseCancelledPrompt = resolve; });
      }
      if (script.requestPermissionOnPrompt) {
        const { toolCallId, title, options } = script.requestPermissionOnPrompt;
        const res = await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId, title },
          options,
        });
        script.onPermissionOutcome?.(res.outcome);
      }
      for (const update of updates) {
        await client.notify('session/update', { sessionId, update });
      }
      return { stopReason };
    });
}
