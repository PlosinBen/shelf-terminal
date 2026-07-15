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
  type AgentApp,
  type SessionUpdate,
  type StopReason,
  type PermissionOption,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

export interface MockAgentScript {
  /** Auth methods advertised at initialize (default: one chatgpt-like method). */
  authMethods?: Array<{ id: string; name: string; description?: string | null }>;
  /** Session id handed back from session/new (default: 'mock-session'). */
  sessionId?: string;
  /** Updates emitted (in order) while handling each session/prompt. */
  updatesOnPrompt?: SessionUpdate[];
  /** Stop reason returned by session/prompt (default: 'end_turn'). */
  stopReason?: StopReason;
  /** Called with each prompt's params — lets a test capture what was sent. */
  onPrompt?: (params: unknown) => void;
  /** Called with session/new params (e.g. to assert additionalDirectories). */
  onNewSession?: (params: unknown) => void;
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

  return agent({ name: 'mock-acp-agent' })
    .onRequest('initialize', ({ params }) => ({
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      authMethods,
    }))
    .onRequest('session/new', ({ params }) => { script.onNewSession?.(params); return { sessionId }; })
    .onRequest('session/resume', () => ({}))
    .onRequest('session/prompt', async ({ params, client }) => {
      script.onPrompt?.(params);
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
