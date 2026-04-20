import type { AgentBackend, AgentEvent, AgentQueryOptions } from '../types';
import type { Connection } from '@shared/types';
import { log } from '@shared/logger';
import { createOpenAIProcessor } from './openai-processor';
import { createToolExecutor } from './tool-executor';
import { getEffortLevels } from './processor-tools';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from '../auth/copilot-auth';

interface CopilotModel {
  id: string;
  name?: string;
  capabilities?: {
    type?: string;
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number };
  };
  model_picker_enabled?: boolean;
}

async function fetchModels(session: { token: string; apiEndpoint: string }): Promise<CopilotModel[]> {
  try {
    const res = await fetch(`${session.apiEndpoint}/models`, {
      headers: {
        'Authorization': `Bearer ${session.token}`,
        'Accept': 'application/json',
        ...COPILOT_DEFAULT_HEADERS,
      },
    });
    if (!res.ok) {
      log.info('copilot', `models endpoint ${res.status}`);
      return [];
    }
    const body = await res.json() as { data?: CopilotModel[] };
    return body.data ?? [];
  } catch (err: any) {
    log.info('copilot', `models fetch failed: ${err?.message}`);
    return [];
  }
}

export function createCopilotBackend(connection: Connection): AgentBackend {
  const contextWindows = new Map<string, number>();
  let lastRateLimit: { rateLimitType?: string; utilization?: number; resetsAt?: number } | null = null;

  // Intercept chat-completion responses to pick up Copilot's quota headers.
  // GitHub mostly uses the standard `x-ratelimit-*` trio; we also peek at the
  // `x-copilot-*` aliases that show up on some endpoints.
  const interceptFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input as any, init);
    try {
      const h = res.headers;
      const limit = h.get('x-ratelimit-limit') ?? h.get('x-copilot-quota-limit');
      const remaining = h.get('x-ratelimit-remaining') ?? h.get('x-copilot-quota-remaining');
      const reset = h.get('x-ratelimit-reset') ?? h.get('x-copilot-quota-reset');
      if (limit && remaining) {
        const total = Number(limit);
        const rem = Number(remaining);
        if (total > 0 && Number.isFinite(rem)) {
          lastRateLimit = {
            rateLimitType: 'copilot',
            utilization: Math.max(0, Math.min(1, (total - rem) / total)),
            resetsAt: reset ? Number(reset) * 1000 : undefined,
          };
        }
      }
    } catch {
      // Header parsing should never break the stream
    }
    return res;
  };

  const processor = createOpenAIProcessor({
    baseURL: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-4o',
    providerName: 'copilot',
    defaultHeaders: COPILOT_DEFAULT_HEADERS,
    tokenProvider: async () => {
      const session = await getCopilotSessionToken();
      return { apiKey: session.token, baseURL: session.apiEndpoint };
    },
    toolExecutor: createToolExecutor(connection),
    getContextWindow: (model) => contextWindows.get(model),
    fetch: interceptFetch,
    getRateLimit: () => lastRateLimit,
  });

  return {
    async checkAuth() {
      return isAuthenticated();
    },
    async warmup() {
      let models: { value: string; displayName: string; effortLevels?: string[] }[] = [];
      try {
        const session = await getCopilotSessionToken();
        const raw = await fetchModels(session);
        const chat = raw.filter((m) => m.capabilities?.type !== 'embeddings' && m.model_picker_enabled !== false);
        for (const m of chat) {
          const window = m.capabilities?.limits?.max_context_window_tokens;
          if (window) contextWindows.set(m.id, window);
        }
        models = chat.map((m) => ({
          value: m.id,
          displayName: m.name ?? m.id,
          effortLevels: getEffortLevels(m.id),
        }));
      } catch (err: any) {
        log.info('copilot', `warmup models skipped: ${err?.message}`);
      }

      return {
        models,
        permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        effortLevels: [],
        slashCommands: processor.getSlashCommands(),
      };
    },
    async getSlashCommands() {
      return processor.getSlashCommands();
    },
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      if (!(await isAuthenticated())) {
        yield { type: 'auth_required', provider: 'copilot' };
        return;
      }
      try {
        yield* processor.query(prompt, cwd, opts);
      } catch (err: any) {
        if (err?.message === 'NO_AUTH') {
          yield { type: 'auth_required', provider: 'copilot' };
          return;
        }
        throw err;
      }
    },
    async stop() {
      await processor.stop();
    },
    dispose() {
      processor.dispose();
    },
    setModel(model: string) {
      processor.setModel(model);
    },
    setEffort(effort: string) {
      processor.setEffort(effort);
    },
  };
}
