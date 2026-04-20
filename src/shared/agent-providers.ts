import type { AgentProvider } from './types';

export interface AgentProviderDef {
  id: AgentProvider;
  label: string;
  /** When true the provider is registered in types but not exposed in any
   * picker UI. Useful when a backend lands before the full surface is ready
   * (e.g. Copilot/Gemini waiting on multi-provider agent-server). */
  hidden?: boolean;
}

export const AGENT_PROVIDERS: AgentProviderDef[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'copilot', label: 'Copilot', hidden: true },
  { id: 'gemini', label: 'Gemini', hidden: true },
];

export const VISIBLE_AGENT_PROVIDERS = AGENT_PROVIDERS.filter((p) => !p.hidden);
