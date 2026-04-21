import type { AgentBackend } from '../types';
import type { Connection } from '@shared/types';
import type { ModelInfo } from '../engine/types';
import { createEngine } from '../engine';
import { createToolExecutor } from '../tools/executor';
import { createConnector } from '../../connector';
import { createStaticCredentialStore } from '../engine/credential';

// Gemini model catalogue — no /models endpoint on Gemini's OpenAI-compat
// adapter, so we ship a static list easy to bump as Google releases models.
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1_048_576, vision: true },
  { id: 'gemini-2.5-pro',   displayName: 'Gemini 2.5 Pro',   contextWindow: 1_048_576, vision: true },
  { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindow: 1_048_576, vision: true },
];

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** Probe Gemini's /models endpoint to verify a key before persisting. Keeps
 * invalid-key feedback at the moment the user hits Save rather than at
 * first-query time. */
async function validateGeminiKey(apiKey: string): Promise<void> {
  const res = await fetch(`${GEMINI_BASE_URL}models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini rejected the key (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export function createGeminiBackend(connection: Connection): AgentBackend {
  const cred = createStaticCredentialStore('gemini', 'GEMINI_API_KEY');
  const contextWindows = new Map(GEMINI_MODELS.map((m) => [m.id, m.contextWindow]));

  return createEngine({
    baseURL: GEMINI_BASE_URL,
    defaultModel: GEMINI_MODELS[0].id,
    providerName: 'gemini',
    toolExecutor: createToolExecutor((cwd, cmd) => createConnector(connection).exec(cwd, cmd)),
    getContextWindow: (model) => contextWindows.get(model),
    tokenProvider: async () => {
      const apiKey = await cred.get();
      if (!apiKey) throw new Error('NO_AUTH');
      return { apiKey };
    },

    // Method-per-capability
    getModels: async () => GEMINI_MODELS,
    authMethod: {
      kind: 'api-key',
      envVar: 'GEMINI_API_KEY',
      setupUrl: 'https://aistudio.google.com/apikey',
      placeholder: 'AIza...',
    },
    customCheckAuth: async () => (await cred.get()) !== null,
    storeCredential: async (key) => {
      await validateGeminiKey(key);
      await cred.set(key);
    },
    clearCredential: async () => cred.clear(),
  });
}
