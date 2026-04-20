import type { AgentBackend, AgentEvent, AgentQueryOptions } from '../types';
import { createOpenAIProcessor } from './openai-processor';

export function createGeminiBackend(): AgentBackend {
  const processor = createOpenAIProcessor({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    providerName: 'gemini',
  });

  return {
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      yield* processor.query(prompt, cwd, opts);
    },
    async stop() {
      await processor.stop();
    },
    dispose() {
      processor.dispose();
    },
  };
}
