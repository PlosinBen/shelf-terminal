import type { AgentBackend } from '../types';
import type { Connection } from '@shared/types';
import type { ModelInfo } from '../engine/types';
import { log } from '@shared/logger';
import { createEngine } from '../engine';
import { createToolExecutor } from '../tools/executor';
import { getEffortLevels } from '../tools/registry';
import { createConnector } from '../../connector';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from '../auth/copilot-auth';

/**
 * Raw shape returned by Copilot's /models endpoint — we keep the subset the
 * engine needs and translate into ModelInfo.
 */
interface CopilotModelRaw {
  id: string;
  name?: string;
  capabilities?: {
    type?: string;
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number };
    supports?: { vision?: boolean; streaming?: boolean; tool_calls?: boolean };
  };
  model_picker_enabled?: boolean;
}

async function fetchCopilotModels(session: { token: string; apiEndpoint: string }): Promise<CopilotModelRaw[]> {
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
    const body = await res.json() as { data?: CopilotModelRaw[] };
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
      // header parsing failures shouldn't break the stream
    }
    return res;
  };

  return createEngine({
    baseURL: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-4o',
    providerName: 'copilot',
    defaultHeaders: COPILOT_DEFAULT_HEADERS,
    tokenProvider: async () => {
      const session = await getCopilotSessionToken();
      return { apiKey: session.token, baseURL: session.apiEndpoint };
    },
    toolExecutor: createToolExecutor((cwd, cmd) => createConnector(connection).exec(cwd, cmd)),
    getContextWindow: (model) => contextWindows.get(model),
    fetch: interceptFetch,
    getRateLimit: () => lastRateLimit,

    // ── Method-per-capability ────────────────────────────────────────────
    async getModels(): Promise<ModelInfo[]> {
      try {
        const session = await getCopilotSessionToken();
        const raw = await fetchCopilotModels(session);
        const chat = raw.filter(
          (m) => m.capabilities?.type !== 'embeddings' && m.model_picker_enabled !== false,
        );
        contextWindows.clear();
        for (const m of chat) {
          const window = m.capabilities?.limits?.max_context_window_tokens;
          if (window) contextWindows.set(m.id, window);
        }
        return chat.map((m) => ({
          id: m.id,
          displayName: m.name ?? m.id,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? 0,
          vision: m.capabilities?.supports?.vision ?? false,
          effortLevels: getEffortLevels(m.id),
        }));
      } catch (err: any) {
        log.info('copilot', `getModels failed: ${err?.message}`);
        return [];
      }
    },

    authMethod: {
      kind: 'oauth',
      instructions: [
        { label: 'Credentials are read from ~/.config/github-copilot/ or gh CLI on the machine running the backend.' },
        { label: 'Install GitHub Copilot CLI and sign in', command: 'npm install -g @github/copilot && copilot' },
        { label: 'Or use GitHub CLI with copilot scope', command: 'gh auth login -s copilot' },
        { label: 'Already signed in with gh? Add the copilot scope', command: 'gh auth refresh -h github.com -s copilot' },
      ],
    },

    customCheckAuth: async () => isAuthenticated(),
  });
}
