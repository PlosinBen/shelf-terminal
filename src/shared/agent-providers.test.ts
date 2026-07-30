import { describe, it, expect } from 'vitest';
import {
  AGENT_CUSTOM_MODEL_PROVIDERS,
  AGENT_PROVIDERS,
  AGENT_PROVIDER_VISIBILITY,
  AGENT_RUNTIME_KIND,
  CLAUDE_PROVIDER,
  CLAUDE_PROVIDER_LABEL,
  CODEX_PROVIDER,
  COPILOT_PROVIDER,
  FAKE_PROVIDER,
  agentProviderEntries,
  providerLabel,
  visibleAgentProviderEntries,
} from './agent-providers';
import { AGENT_PROVIDER_REGISTRY } from './types';

// Locks the single-source provider registry: every consumer (AgentProvider type,
// agent-server backend dispatch, New-tab menu, project-config select, remote deploy
// binary) derives from this. A change here is intentional + visible.
describe('AGENT_PROVIDERS registry', () => {
  it('enumerates exactly the known providers, in order', () => {
    // Post-cutover: `copilot` IS the ACP backend; no separate `acp-copilot`.
    expect(agentProviderEntries().map(([id]) => id)).toEqual([
      CLAUDE_PROVIDER,
      COPILOT_PROVIDER,
      CODEX_PROVIDER,
      FAKE_PROVIDER,
    ]);
  });

  it('carries the user-visible label per provider', () => {
    expect(providerLabel(CLAUDE_PROVIDER)).toBe(CLAUDE_PROVIDER_LABEL);
    expect(providerLabel(FAKE_PROVIDER)).toBe('Test Agent');
  });

  it('filters internal providers only at the presentation boundary', () => {
    expect(AGENT_PROVIDERS[FAKE_PROVIDER].visibility).toBe(AGENT_PROVIDER_VISIBILITY.INTERNAL);
    expect(visibleAgentProviderEntries(false).map(([id]) => id)).toEqual([
      CLAUDE_PROVIDER,
      COPILOT_PROVIDER,
      CODEX_PROVIDER,
    ]);
    expect(visibleAgentProviderEntries(true).map(([id]) => id)).toEqual([
      CLAUDE_PROVIDER,
      COPILOT_PROVIDER,
      CODEX_PROVIDER,
      FAKE_PROVIDER,
    ]);
  });

  it('maps each provider to its remote-deploy binary', () => {
    expect(AGENT_PROVIDERS[CLAUDE_PROVIDER].bin).toBe(AGENT_RUNTIME_KIND.CLAUDE);
    // copilot (now ACP-backed) still ships the copilot binary (`copilot --acp`).
    expect(AGENT_PROVIDERS[COPILOT_PROVIDER].bin).toBe(AGENT_RUNTIME_KIND.COPILOT);
    // Codex is a deployed runtime tree, never a fallback to another provider.
    expect(AGENT_PROVIDERS[CODEX_PROVIDER].bin).toBe(AGENT_RUNTIME_KIND.CODEX);
    expect(AGENT_PROVIDERS[FAKE_PROVIDER].bin).toBeNull();
  });

  it('derives the Claude-only custom-model subset from shared identity', () => {
    expect(AGENT_CUSTOM_MODEL_PROVIDERS).toEqual([CLAUDE_PROVIDER]);
    expect(AGENT_PROVIDER_REGISTRY).toEqual([
      { id: CLAUDE_PROVIDER, label: CLAUDE_PROVIDER_LABEL, models: [] },
    ]);
  });
});
