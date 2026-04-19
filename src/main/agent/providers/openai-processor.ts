import OpenAI from 'openai';
import type { AgentEvent, AgentQueryOptions } from '../types';
import { log } from '@shared/logger';
import { TOOLS, toolsForMode, toOpenAIFormat, shouldAllowAutomatically, shouldDenyAutomatically } from './processor-tools';
import type { ToolExecutor } from './tool-executor';

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel: string;
  providerName: string;
  defaultHeaders?: Record<string, string>;
  /** Called before each request. Returns { apiKey, baseURL? } to use for this call. */
  tokenProvider?: () => Promise<{ apiKey: string; baseURL?: string }>;
  toolExecutor?: ToolExecutor;
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
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
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
            const category = TOOLS[call.name]?.category ?? 'exec';

            yield {
              type: 'message',
              payload: {
                type: 'tool_use', content: '',
                toolName: call.name, toolInput, toolUseId: call.id,
              },
            };

            let resultText: string | null = null;

            if (shouldDenyAutomatically(mode, category)) {
              resultText = `Denied: tool ${call.name} (${category}) is not allowed in ${mode} mode`;
            } else if (!shouldAllowAutomatically(mode, category) && opts?.canUseTool) {
              const decision = await opts.canUseTool(call.id, call.name, toolInput);
              if (decision.behavior === 'deny') {
                resultText = `Denied by user${decision.message ? `: ${decision.message}` : ''}`;
              }
            }

            if (resultText === null) {
              try {
                if (!config.toolExecutor) throw new Error('Tool executor not configured');
                resultText = await config.toolExecutor.execute(call.name, toolInput, cwd);
              } catch (err: any) {
                resultText = `Error: ${err.message ?? 'tool execution failed'}`;
              }
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
