import type { AgentBackend } from '../types';
import type { Connection } from '@shared/types';
import type { ModelInfo } from '../engine/types';
import { log } from '@shared/logger';
import { createEngine } from '../engine';
import { createFileHistoryStore } from '../engine/history-store';
import { createToolExecutor } from '../tools/executor';
import { getEffortLevels } from '../tools/registry';
import { createConnector } from '../../connector';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from '../auth/copilot-auth';

/**
 * Raw shape returned by Copilot's /models endpoint — we keep the subset the
 * engine needs and translate into ModelInfo.
 */
export interface CopilotModelRaw {
  id: string;
  name?: string;
  capabilities?: {
    type?: string;
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number };
    supports?: { vision?: boolean; streaming?: boolean; tool_calls?: boolean };
  };
  model_picker_enabled?: boolean;
  /**
   * Which Copilot backends this model is reachable through. Newer entries
   * like gpt-5.x-codex are `type: chat` but only expose `/responses`, so
   * calling `/chat/completions` 400s. Older chat models omit this field
   * entirely — we treat absence as "serves /chat/completions".
   */
  supported_endpoints?: string[];
}

/**
 * Keep only models the chat-completions API can actually serve. Copilot's
 * /models endpoint advertises capabilities beyond chat (embeddings,
 * completion-only codex variants, etc.) and — more subtly — some `type: chat`
 * entries only expose `/responses`. Require `capabilities.type === 'chat'`
 * AND that `supported_endpoints` (when present) includes `/chat/completions`.
 */
export function filterChatModels(raw: CopilotModelRaw[]): CopilotModelRaw[] {
  return raw.filter((m) => {
    if (m.capabilities?.type !== 'chat') return false;
    if (m.model_picker_enabled === false) return false;
    if (m.supported_endpoints && !m.supported_endpoints.includes('/chat/completions')) return false;
    return true;
  });
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
    historyStore: createFileHistoryStore(),
    defaultHeaders: COPILOT_DEFAULT_HEADERS,
    tokenProvider: async () => {
      const session = await getCopilotSessionToken();
      return { apiKey: session.token, baseURL: session.apiEndpoint };
    },
    toolExecutor: createToolExecutor((cwd, cmd) => createConnector(connection).exec(cwd, cmd)),
    getContextWindow: (model) => contextWindows.get(model),
    fetch: interceptFetch,
    getRateLimit: () => lastRateLimit,
    // gpt-4o-mini: ~20× cheaper than gpt-4o/gpt-5 and unmetered in most
    // Copilot plans, so it's the obvious summariser. We only pick it when
    // `getModels()` has already populated contextWindows (proof the model
    // exists in the user's quota); otherwise fall through to current to
    // avoid 4xx-ing the compact call on a phantom model id.
    pickCompactModel: (current) => {
      const preferred = 'gpt-4o-mini';
      if (current === preferred) return undefined;
      return contextWindows.has(preferred) ? preferred : undefined;
    },

    // ── Method-per-capability ────────────────────────────────────────────
    async getModels(): Promise<ModelInfo[]> {
      try {
        const session = await getCopilotSessionToken();
        const raw = await fetchCopilotModels(session);
        const chat = filterChatModels(raw);
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
