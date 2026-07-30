import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  COPILOT_PROVIDER,
  FAKE_PROVIDER,
  type AgentProvider,
} from '@shared/agent-providers';
import type { ServerBackend } from './providers/types';
import { createBackendRegistry, type BackendFactory } from './backend-registry';

function backend(name: string): ServerBackend & { name: string } {
  return {
    name,
    query: async () => {},
    stop: async () => {},
    dispose: () => {},
  };
}

function factories(): Record<AgentProvider, BackendFactory> {
  return {
    [CLAUDE_PROVIDER]: () => backend(CLAUDE_PROVIDER),
    [COPILOT_PROVIDER]: () => backend(COPILOT_PROVIDER),
    [CODEX_PROVIDER]: () => backend(CODEX_PROVIDER),
    [FAKE_PROVIDER]: () => backend(FAKE_PROVIDER),
  };
}

describe('createBackendRegistry', () => {
  it('uses the exhaustive real factory for explicit fake selection', () => {
    const registry = createBackendRegistry(factories(), false, vi.fn());

    expect((registry.get(FAKE_PROVIDER) as { name: string }).name).toBe(FAKE_PROVIDER);
  });

  it('preserves requested identities when substituting fake implementations', () => {
    const createTestBackend = vi.fn((provider: AgentProvider) => backend(`fake-for:${provider}`));
    const registry = createBackendRegistry(factories(), true, createTestBackend);

    const claude = registry.get(CLAUDE_PROVIDER);
    const copilot = registry.get(COPILOT_PROVIDER);
    const codex = registry.get(CODEX_PROVIDER);
    const explicitFake = registry.get(FAKE_PROVIDER);

    expect(createTestBackend.mock.calls.map(([provider]) => provider)).toEqual([
      CLAUDE_PROVIDER,
      COPILOT_PROVIDER,
      CODEX_PROVIDER,
      FAKE_PROVIDER,
    ]);
    expect(new Set([claude, copilot, codex, explicitFake]).size).toBe(4);
    expect(registry.get(CLAUDE_PROVIDER)).toBe(claude);
  });
});
