import type { AgentBackend, AgentEvent, AgentQueryOptions } from '../types';
import type { Connection } from '@shared/types';
import { createOpenAIProcessor } from './openai-processor';
import { createToolExecutor } from './tool-executor';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from '../auth/copilot-auth';

export function createCopilotBackend(connection: Connection): AgentBackend {
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
  });

  return {
    async checkAuth() {
      return isAuthenticated();
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
  };
}
