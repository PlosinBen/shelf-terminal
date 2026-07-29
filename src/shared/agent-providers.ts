// Single source of truth for the set of agent providers. Everything that used to
// hardcode a provider list — the `AgentProvider` type union, the agent-server
// backend dispatch, the "New agent tab" menu, the project-config default-provider
// select, and the remote deploy binary choice — derives from THIS registry. Adding
// a provider = one entry here (+ its backend factory in agent-server exec).
//
// No `availability`/gating field by design: registry membership means the
// provider is shown everywhere. A missing CLI/runtime fails loud at spawn.

export interface AgentProviderMeta {
  /** Display name (New-tab menu, project config). */
  label: string;
  /** The self-contained runtime kind the remote deploy ships for this provider. */
  bin: 'claude' | 'copilot' | 'codex';
}

export const CODEX_PROVIDER = 'codex';

// `copilot` is driven by the ACP backend (agent-server/providers/copilot/,
// createCopilotBackend launching `copilot --acp`). The pre-ACP native SDK backend
// was deleted at cutover — recoverable from git history at the pre-cutover commit.
export const AGENT_PROVIDERS = {
  claude:  { label: 'Claude',                 bin: 'claude'  },
  copilot: { label: 'Copilot',                bin: 'copilot' },
  [CODEX_PROVIDER]: { label: 'Codex', bin: 'codex' },
} as const satisfies Record<string, AgentProviderMeta>;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_PROVIDERS, value);
}

/** The providers in registry order, as `[id, meta]` pairs — for menus / selects. */
export function agentProviderEntries(): Array<[AgentProvider, AgentProviderMeta]> {
  return Object.entries(AGENT_PROVIDERS) as Array<[AgentProvider, AgentProviderMeta]>;
}
