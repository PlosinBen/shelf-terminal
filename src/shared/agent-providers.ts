// Single source of truth for the set of agent providers. Everything that used to
// hardcode a provider list — the `AgentProvider` type union, the agent-server
// backend dispatch, the "New agent tab" menu, the project-config default-provider
// select, and the remote deploy binary choice — derives from THIS registry. Adding
// a provider = one entry here (+ its backend factory in agent-server exec).
//
// No `availability`/gating field by design: a not-yet-GA provider marks itself in
// its `label` (a trailing "· dev"), and is shown everywhere — exposure in a
// production build is acceptable (the label communicates it; a missing CLI fails
// loud at spawn).

export interface AgentProviderMeta {
  /** Display name (New-tab menu, project config). A trailing "· dev" flags a
   *  not-yet-GA provider — delete the suffix when it ships. */
  label: string;
  /** The self-contained CLI the remote deploy ships for this provider. `null` =
   *  no self-contained binary yet (codex is resolved/bundled differently; its
   *  remote deploy is a separate future task). */
  bin: 'claude' | 'copilot' | null;
}

// CUTOVER (copilot on ACP): `copilot` is now driven by the ACP backend
// (createCopilotAcpBackend in exec.ts) — there is no separate `acp-copilot` provider
// anymore. The native SDK backend (providers/copilot/index.ts) is kept UNWIRED in the
// tree as a one-line rollback lever during field-test, then deleted + the acp-copilot/
// dir renamed to copilot/ in a follow-up cleanup. See the copilot-acp feature note.
export const AGENT_PROVIDERS = {
  claude:  { label: 'Claude',      bin: 'claude'  },
  copilot: { label: 'Copilot',     bin: 'copilot' },
  codex:   { label: 'Codex · dev', bin: null      },
} as const satisfies Record<string, AgentProviderMeta>;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;

/** The providers in registry order, as `[id, meta]` pairs — for menus / selects. */
export function agentProviderEntries(): Array<[AgentProvider, AgentProviderMeta]> {
  return Object.entries(AGENT_PROVIDERS) as Array<[AgentProvider, AgentProviderMeta]>;
}
