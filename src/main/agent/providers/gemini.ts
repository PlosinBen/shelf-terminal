import type { AgentBackend, AgentEvent, AgentQueryOptions } from '../types';
import type { Connection } from '@shared/types';
import { log } from '@shared/logger';
import { createOpenAIProcessor } from './openai-processor';
import { createToolExecutor } from './tool-executor';
import { createConnector } from '../../connector';

// Gemini model catalogue. The OpenAI-compatible endpoint doesn't advertise a
// /models list the same way Copilot's does, so we ship a static set that is
// easy to bump when Google ships new models.
const GEMINI_MODELS: { value: string; displayName: string; contextWindow: number; vision: boolean }[] = [
  { value: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1_048_576, vision: true },
  { value: 'gemini-2.5-pro',   displayName: 'Gemini 2.5 Pro',   contextWindow: 1_048_576, vision: true },
  { value: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindow: 1_048_576, vision: true },
];

export function createGeminiBackend(connection: Connection): AgentBackend {
  const contextWindows = new Map(GEMINI_MODELS.map((m) => [m.value, m.contextWindow]));

  const processor = createOpenAIProcessor({
    apiKey: process.env.GEMINI_API_KEY ?? 'missing',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: GEMINI_MODELS[0].value,
    providerName: 'gemini',
    toolExecutor: createToolExecutor((cwd, cmd) => createConnector(connection).exec(cwd, cmd)),
    getContextWindow: (model) => contextWindows.get(model),
  });

  return {
    async checkAuth() {
      // First-pass: the only supported auth is a GEMINI_API_KEY env var on the
      // machine the backend runs on. Anything more (OAuth, gcloud) can land
      // later.
      return !!process.env.GEMINI_API_KEY;
    },

    async warmup() {
      return {
        models: GEMINI_MODELS.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          vision: m.vision,
        })),
        permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        effortLevels: [],
        slashCommands: processor.getSlashCommands(),
      };
    },

    async getSlashCommands() {
      return processor.getSlashCommands();
    },

    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      if (!process.env.GEMINI_API_KEY) {
        yield { type: 'auth_required', provider: 'gemini' };
        return;
      }
      try {
        yield* processor.query(prompt, cwd, opts);
      } catch (err: any) {
        log.error('gemini', `query error: ${err?.message}`);
        throw err;
      }
    },

    async stop() { await processor.stop(); },
    dispose() { processor.dispose(); },
    setModel(model: string) { processor.setModel(model); },
    setEffort(effort: string) { processor.setEffort(effort); },
  };
}
