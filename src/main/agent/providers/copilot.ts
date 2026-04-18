import type { AgentBackend, AgentEvent, AgentQueryOptions } from '../types';
import { createOpenAIProcessor } from './openai-processor';

export function createCopilotBackend(): AgentBackend {
  const processor = createOpenAIProcessor({
    baseURL: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-4o',
    providerName: 'copilot',
    defaultHeaders: {
      'Editor-Version': 'shelf-terminal/1.0',
    },
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
