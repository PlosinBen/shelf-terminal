import { describe, it, expect } from 'vitest';
import { AGENT_PROVIDERS, agentProviderEntries } from './agent-providers';

// Locks the single-source provider registry: every consumer (AgentProvider type,
// agent-server backend dispatch, New-tab menu, project-config select, remote deploy
// binary) derives from this. A change here is intentional + visible.
describe('AGENT_PROVIDERS registry', () => {
  it('enumerates exactly the known providers, in order', () => {
    expect(agentProviderEntries().map(([id]) => id)).toEqual([
      'claude', 'copilot', 'codex', 'acp-copilot',
    ]);
  });

  it('carries a label per provider; not-yet-GA ones are marked "· dev"', () => {
    expect(AGENT_PROVIDERS.claude.label).toBe('Claude');
    expect(AGENT_PROVIDERS.copilot.label).toBe('Copilot');
    expect(AGENT_PROVIDERS.codex.label).toContain('· dev');
    expect(AGENT_PROVIDERS['acp-copilot'].label).toContain('· dev');
  });

  it('maps each provider to its remote-deploy binary (acp-copilot ships copilot, not claude)', () => {
    expect(AGENT_PROVIDERS.claude.bin).toBe('claude');
    expect(AGENT_PROVIDERS.copilot.bin).toBe('copilot');
    // The bug the registry fixes: acp-copilot runs `copilot --acp` → needs the
    // copilot binary (the old `=== 'copilot'` check shipped claude for it).
    expect(AGENT_PROVIDERS['acp-copilot'].bin).toBe('copilot');
    // codex has no self-contained binary yet (deployed differently).
    expect(AGENT_PROVIDERS.codex.bin).toBeNull();
  });
});
