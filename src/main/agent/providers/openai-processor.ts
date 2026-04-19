import OpenAI from 'openai';
import type { AgentEvent, AgentQueryOptions } from '../types';
import { log } from '@shared/logger';
import { toolsForMode, toOpenAIFormat } from './processor-tools';

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
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const MAX_TURNS = 20;

function safeParseJSON(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return { _raw: s }; }
}

async function executeTool(name: string): Promise<string> {
  // Phase 3a stub — tool execution is wired up in Phase 3b.
  throw new Error(`Tool execution not implemented yet: ${name}`);
}

export function createOpenAIProcessor(config: OpenAIProviderConfig) {
  let abortController: AbortController | null = null;
  let history: Message[] = [];

  async function getClient(): Promise<OpenAI> {
    if (config.tokenProvider) {
      const { apiKey, baseURL } = await config.tokenProvider();
      return new OpenAI({ apiKey, baseURL: baseURL ?? config.baseURL, defaultHeaders: config.defaultHeaders });
    }
    return new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? 'dummy',
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    });
  }

  return {
    async *query(prompt: string, _cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      abortController = new AbortController();
      history.push({ role: 'user', content: prompt });

      const mode = opts?.permissionMode ?? 'default';
      const tools = toOpenAIFormat(toolsForMode(mode));

      yield { type: 'status', payload: { state: 'streaming', model: config.defaultModel } };

      try {
        const oai = await getClient();

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const stream = await oai.chat.completions.create({
            model: config.defaultModel,
            messages: history as any,
            tools: tools.length > 0 ? tools : undefined,
            stream: true,
            stream_options: { include_usage: true },
          }, { signal: abortController.signal });

          let content = '';
          const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
          let finishReason: string | null = null;
          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

          for await (const chunk of stream) {
            if (chunk.usage) usage = chunk.usage as any;
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (!delta) continue;

            if (delta.content) {
              content += delta.content;
              yield { type: 'stream', payload: { type: 'text', content: delta.content } };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const slot = toolCalls[idx] ?? (toolCalls[idx] = { id: '', name: '', args: '' });
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (tc.function?.arguments) slot.args += tc.function.arguments;
              }
            }
          }

          const calls = Object.values(toolCalls).filter((c) => c.name);

          if (content || calls.length > 0) {
            history.push({
              role: 'assistant',
              content: content || null,
              tool_calls: calls.length > 0
                ? calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
                : undefined,
            });
          }

          if (content) {
            yield { type: 'message', payload: { type: 'text', content } };
          }

          if (usage) {
            yield {
              type: 'status',
              payload: {
                state: calls.length > 0 ? 'streaming' : 'idle',
                model: config.defaultModel,
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
              },
            };
          }

          if (calls.length === 0 || finishReason !== 'tool_calls') {
            break;
          }

          for (const call of calls) {
            const toolInput = safeParseJSON(call.args);
            yield {
              type: 'message',
              payload: {
                type: 'tool_use', content: '',
                toolName: call.name, toolInput, toolUseId: call.id,
              },
            };

            let resultText: string;
            try {
              resultText = await executeTool(call.name);
            } catch (err: any) {
              resultText = `Error: ${err.message ?? 'tool execution failed'}`;
            }

            history.push({ role: 'tool', tool_call_id: call.id, content: resultText });
            yield {
              type: 'message',
              payload: { type: 'tool_result', content: resultText, toolUseId: call.id },
            };
          }
        }

        yield { type: 'status', payload: { state: 'idle', model: config.defaultModel } };
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
