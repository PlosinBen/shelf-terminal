// Mock ACP agent fixture (TEST-ONLY — never imported by exec.ts, so it is
// tree-shaken out of the production agent-server bundle).
//
// A scriptable in-process ACP *agent* built on the real @agentclientprotocol/sdk,
// so the shared acp/ toolkit + the codex backend can be exercised end-to-end
// (initialize → session/new → prompt → session/update stream → permission → stop)
// with NO real codex, NO stdio, and NO credentials. This is the test enabler for
// Phase 1–2 (see acp-provider feature note, T1.0).

import { agent, type AgentApp, type SessionUpdate, type StopReason } from '@agentclientprotocol/sdk';

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
    .onRequest('session/new', () => ({ sessionId }))
    .onRequest('session/prompt', async ({ params, client }) => {
      script.onPrompt?.(params);
      for (const update of updates) {
        await client.notify('session/update', { sessionId, update });
      }
      return { stopReason };
    });
}
