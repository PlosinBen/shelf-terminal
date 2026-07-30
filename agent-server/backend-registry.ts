import type { AgentProvider } from '@shared/agent-providers';
import type { ServerBackend } from './providers/types';

export type BackendFactory = () => ServerBackend;

export interface BackendRegistry {
  get(provider: AgentProvider): ServerBackend;
  values(): ServerBackend[];
}

/**
 * Cache one backend per concrete provider identity. Test mode substitutes the
 * implementation, never the key: each requested provider gets its own fake
 * instance and therefore its own backend-local state.
 */
export function createBackendRegistry(
  factories: Record<AgentProvider, BackendFactory>,
  testMode: boolean,
  createTestBackend: (provider: AgentProvider) => ServerBackend,
): BackendRegistry {
  const backends = new Map<AgentProvider, ServerBackend>();

  return {
    get(provider) {
      let backend = backends.get(provider);
      if (backend) return backend;
      backend = testMode ? createTestBackend(provider) : factories[provider]();
      backends.set(provider, backend);
      return backend;
    },
    values: () => [...backends.values()],
  };
}
