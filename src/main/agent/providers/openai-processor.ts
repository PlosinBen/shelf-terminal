import OpenAI from 'openai';
import type { AgentEvent, AgentQueryOptions, PermissionCallback, PermissionResult } from '../types';
import { log } from '@shared/logger';

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel: string;
  providerName: string;
  defaultHeaders?: Record<string, string>;
  /** Called before each request. Returns { apiKey, baseURL? } to use for this call. */
  tokenProvider?: () => Promise<{ apiKey: string; baseURL?: string }>;
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export function createOpenAIProcessor(config: OpenAIProviderConfig) {
  let abortController: AbortController | null = null;
  let history: Message[] = [];

  async function getClient(): Promise<OpenAI> {
    if (config.tokenProvider) {
      const { apiKey, baseURL } = await config.tokenProvider();
      return new OpenAI({
        apiKey,
        baseURL: baseURL ?? config.baseURL,
        defaultHeaders: config.defaultHeaders,
      });
    }
    return new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? 'dummy',
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    });
  }

  return {
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      abortController = new AbortController();

      history.push({ role: 'user', content: prompt });

      yield { type: 'status', payload: { state: 'streaming', model: config.defaultModel } };

      try {
        const oai = await getClient();
        const stream = await oai.chat.completions.create({
          model: config.defaultModel,
          messages: history as any,
          stream: true,
        }, { signal: abortController.signal });

        let fullContent = '';

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            yield { type: 'stream', payload: { type: 'text', content: delta.content } };
          }
        }

        if (fullContent) {
          history.push({ role: 'assistant', content: fullContent });
          yield {
            type: 'message',
            payload: { type: 'text', content: fullContent },
          };
        }

        yield {
          type: 'status',
          payload: { state: 'idle', model: config.defaultModel },
        };
      } catch (err: any) {
        if (err?.message === 'NO_AUTH') throw err;
        if (err.name !== 'AbortError') {
          log.error('openai-processor', `Query error: ${err.message}`);
          yield { type: 'error', error: err.message ?? 'Unknown error' };
        }
      } finally {
        abortController = null;
      }
    },

    async stop() {
      abortController?.abort();
    },

    dispose() {
      abortController?.abort();
      abortController = null;
      history = [];
    },

    getHistory() {
      return [...history];
    },

    clearHistory() {
      history = [];
    },
  };
}
