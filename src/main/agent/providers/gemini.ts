import type { AgentBackend } from '../types';
import type { Connection } from '@shared/types';
import type { ModelInfo } from '../engine/types';
import { createEngine } from '../engine';
import { createToolExecutor } from '../tools/executor';
import { createConnector } from '../../connector';

// Gemini model catalogue. The OpenAI-compatible endpoint doesn't advertise a
// /models list, so we ship a static set that's easy to bump as Google releases
// new models.
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1_048_576, vision: true },
  { id: 'gemini-2.5-pro',   displayName: 'Gemini 2.5 Pro',   contextWindow: 1_048_576, vision: true },
  { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindow: 1_048_576, vision: true },
];

export function createGeminiBackend(connection: Connection): AgentBackend {
  const contextWindows = new Map(GEMINI_MODELS.map((m) => [m.id, m.contextWindow]));

  return createEngine({
    apiKey: process.env.GEMINI_API_KEY ?? 'missing',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: GEMINI_MODELS[0].id,
    providerName: 'gemini',
    toolExecutor: createToolExecutor((cwd, cmd) => createConnector(connection).exec(cwd, cmd)),
    getContextWindow: (model) => contextWindows.get(model),

    // Method-per-capability
    getModels: async () => GEMINI_MODELS,
    authMethod: {
      kind: 'api-key',
      envVar: 'GEMINI_API_KEY',
      setupUrl: 'https://aistudio.google.com/apikey',
      placeholder: 'AIza...',
    },
    customCheckAuth: async () => !!process.env.GEMINI_API_KEY,
  });
}
