// Single source of truth for agent-provider identity and presentation metadata.
// Provider implementations, persistence, renderer, and deployment carry these
// opaque keys unchanged; user-facing identity resolves through the registry.

export const CLAUDE_PROVIDER = 'claude';
export const COPILOT_PROVIDER = 'copilot';
export const CODEX_PROVIDER = 'codex';
export const FAKE_PROVIDER = 'fake';

export const CLAUDE_PROVIDER_LABEL = 'Claude';
export const COPILOT_PROVIDER_LABEL = 'Copilot';
export const CODEX_PROVIDER_LABEL = 'Codex';
export const FAKE_PROVIDER_LABEL = 'Test Agent';

export const AGENT_PROVIDER_VISIBILITY = {
  PRODUCT: 'product',
  INTERNAL: 'internal',
} as const;
export type AgentProviderVisibility =
  (typeof AGENT_PROVIDER_VISIBILITY)[keyof typeof AGENT_PROVIDER_VISIBILITY];

export const AGENT_RUNTIME_KIND = {
  CLAUDE: 'claude',
  COPILOT: 'copilot',
  CODEX: 'codex',
} as const;
export type AgentRuntimeKind =
  (typeof AGENT_RUNTIME_KIND)[keyof typeof AGENT_RUNTIME_KIND];

export interface AgentProviderMeta {
  /** Product-facing display name. */
  label: string;
  /** Whether production UI exposes the provider. */
  visibility: AgentProviderVisibility;
  /** Additional self-contained runtime shipped remotely; null means base runtime only. */
  bin: AgentRuntimeKind | null;
}

// `copilot` is driven by the ACP backend. ACP is an implementation detail; the
// provider identity remains `copilot`.
export const AGENT_PROVIDERS = {
  [CLAUDE_PROVIDER]: {
    label: CLAUDE_PROVIDER_LABEL,
    visibility: AGENT_PROVIDER_VISIBILITY.PRODUCT,
    bin: AGENT_RUNTIME_KIND.CLAUDE,
  },
  [COPILOT_PROVIDER]: {
    label: COPILOT_PROVIDER_LABEL,
    visibility: AGENT_PROVIDER_VISIBILITY.PRODUCT,
    bin: AGENT_RUNTIME_KIND.COPILOT,
  },
  [CODEX_PROVIDER]: {
    label: CODEX_PROVIDER_LABEL,
    visibility: AGENT_PROVIDER_VISIBILITY.PRODUCT,
    bin: AGENT_RUNTIME_KIND.CODEX,
  },
  [FAKE_PROVIDER]: {
    label: FAKE_PROVIDER_LABEL,
    visibility: AGENT_PROVIDER_VISIBILITY.INTERNAL,
    bin: null,
  },
} as const satisfies Record<string, AgentProviderMeta>;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;
export type AgentProviderEntry = [AgentProvider, AgentProviderMeta];

export const AGENT_CUSTOM_MODEL_PROVIDERS = [CLAUDE_PROVIDER] as const;
export type AgentCustomModelProvider = (typeof AGENT_CUSTOM_MODEL_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_PROVIDERS, value);
}

/** Every registered provider, including internal providers. */
export function agentProviderEntries(): AgentProviderEntry[] {
  return Object.entries(AGENT_PROVIDERS) as AgentProviderEntry[];
}

/** UI-visible providers under the caller-owned environment policy. */
export function visibleAgentProviderEntries(includeInternal: boolean): AgentProviderEntry[] {
  return agentProviderEntries().filter(([, meta]) =>
    includeInternal || meta.visibility === AGENT_PROVIDER_VISIBILITY.PRODUCT);
}

export function providerLabel(provider: AgentProvider): string {
  return AGENT_PROVIDERS[provider].label;
}
