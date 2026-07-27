import { describe, it, expect } from 'vitest';
import { AGENT_PROVIDERS, CODEX_OFFICAL_PROVIDER, agentProviderEntries } from './agent-providers';

// Locks the single-source provider registry: every consumer (AgentProvider type,
// agent-server backend dispatch, New-tab menu, project-config select, remote deploy
// binary) derives from this. A change here is intentional + visible.
describe('AGENT_PROVIDERS registry', () => {
  it('enumerates exactly the known providers, in order', () => {
    // Post-cutover: `copilot` IS the ACP backend; no separate `acp-copilot`.
    expect(agentProviderEntries().map(([id]) => id)).toEqual(['claude', 'copilot', 'codex', CODEX_OFFICAL_PROVIDER]);
  });

  it('carries the user-visible label per provider', () => {
    expect(AGENT_PROVIDERS.claude.label).toBe('Claude');
    expect(AGENT_PROVIDERS.copilot.label).toBe('Copilot');
    expect(AGENT_PROVIDERS.codex.label).toBe('Codex');
    expect(AGENT_PROVIDERS[CODEX_OFFICAL_PROVIDER].label).toBe('Codex Official (Test)');
  });

  it('maps each provider to its remote-deploy binary', () => {
    expect(AGENT_PROVIDERS.claude.bin).toBe('claude');
    // copilot (now ACP-backed) still ships the copilot binary (`copilot --acp`).
    expect(AGENT_PROVIDERS.copilot.bin).toBe('copilot');
    // Codex is a deployed runtime tree, never a fallback to another provider.
    expect(AGENT_PROVIDERS.codex.bin).toBe('codex');
    // Temporary official-SDK provider shares the exact Codex runtime tree.
    expect(AGENT_PROVIDERS[CODEX_OFFICAL_PROVIDER].bin).toBe('codex');
  });
});
