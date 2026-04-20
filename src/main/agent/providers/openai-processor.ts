import OpenAI from 'openai';
import type { AgentEvent, AgentQueryOptions } from '../types';
import { log } from '@shared/logger';
import { TOOLS, toolsForMode, toOpenAIFormat, shouldAllowAutomatically, shouldDenyAutomatically, buildSystemPrompt, SLASH_COMMANDS, getEffortLevels } from './processor-tools';
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
  /** Lookup context window size (tokens) for a given model id. */
  getContextWindow?: (model: string) => number | undefined;
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
  let currentModel = config.defaultModel;
  let currentEffort: string | null = null;
  let lastUsage: { prompt: number; completion: number } | null = null;
  let turnCount = 0;

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

      const mode = opts?.permissionMode ?? 'default';

      const trimmed = prompt.trim();
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        const arg = rest.join(' ').trim();
        const reply = await handleSlash(cmd, arg, cwd, mode);
        if (reply !== null) {
          yield { type: 'message', payload: { type: 'text', content: reply } };
          yield { type: 'status', payload: { state: 'idle', model: currentModel } };
          return;
        }
      }
      const systemPrompt = buildSystemPrompt(cwd, mode);
      if (history.length > 0 && history[0].role === 'system') {
        history[0].content = systemPrompt;
      } else {
        history.unshift({ role: 'system', content: systemPrompt });
      }
      history.push({ role: 'user', content: prompt });

      const tools = toOpenAIFormat(toolsForMode(mode));

      yield { type: 'status', payload: { state: 'streaming', model: currentModel } };

      try {
        const oai = await getClient();

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const supportedEfforts = getEffortLevels(currentModel);
          const effort = (supportedEfforts.length > 0 && currentEffort && supportedEfforts.includes(currentEffort))
            ? currentEffort : undefined;
          const params = {
            model: currentModel,
            messages: history as any,
            tools: tools.length > 0 ? tools : undefined,
            stream: true as const,
            stream_options: { include_usage: true },
            ...(effort ? { reasoning_effort: effort as any } : {}),
          };
          const stream = await oai.chat.completions.create(params, { signal: abortController.signal });

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
            lastUsage = { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 };
            turnCount++;
            const contextWindow = config.getContextWindow?.(currentModel);
            yield {
              type: 'status',
              payload: {
                state: calls.length > 0 ? 'streaming' : 'idle',
                model: currentModel,
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                contextUsedTokens: usage.prompt_tokens,
                contextWindow,
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

        yield { type: 'status', payload: { state: 'idle', model: currentModel } };
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

    setModel(model: string) {
      currentModel = model;
    },

    getModel() {
      return currentModel;
    },

    setEffort(effort: string) {
      currentEffort = effort || null;
    },

    getSlashCommands() {
      return SLASH_COMMANDS;
    },
  };

  async function handleSlash(cmd: string, arg: string, cwd: string, mode: string): Promise<string | null> {
    switch (cmd) {
      case 'clear':
        history = [];
        lastUsage = null;
        turnCount = 0;
        return 'Conversation history cleared.';

      case 'compact': {
        if (history.length < 4) return 'Not enough history to compact yet.';

        const systemMsg = history[0]?.role === 'system' ? history[0] : null;
        // Keep the last 2 user turns (and whatever followed) verbatim.
        let userSeen = 0;
        let splitIdx = history.length;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === 'user') {
            userSeen++;
            if (userSeen === 2) { splitIdx = i; break; }
          }
        }
        const head = systemMsg ? 1 : 0;
        const toCompact = history.slice(head, splitIdx);
        const toKeep = history.slice(splitIdx);
        if (toCompact.length === 0) return 'Nothing older than recent turns to compact.';

        const oai = await getClient();
        const result = await oai.chat.completions.create({
          model: currentModel,
          messages: [
            ...(systemMsg ? [systemMsg] : []),
            ...toCompact,
            {
              role: 'user',
              content: 'Summarise the conversation above into a concise briefing I can use as context for continuing. Preserve file paths, decisions already made, open questions, and key technical details. Drop chitchat, resolved exchanges, and verbose thinking. Aim for ~200 words.',
            },
          ] as any,
          stream: false,
        });
        const summary = result.choices[0]?.message?.content ?? '(empty summary)';

        history = [
          ...(systemMsg ? [systemMsg] : []),
          { role: 'assistant', content: `[Compacted context from earlier turns]\n\n${summary}` },
          ...toKeep,
        ];
        return `Compacted ${toCompact.length} earlier messages.\n\n${summary}`;
      }

      case 'model':
        if (!arg) return null; // handled by renderer picker
        currentModel = arg;
        return `Model switched to \`${arg}\`.`;

      case 'context': {
        const window = config.getContextWindow?.(currentModel);
        const lines = [
          `Turns: ${turnCount}`,
          lastUsage
            ? `Last tokens: ${lastUsage.prompt} in / ${lastUsage.completion} out`
            : 'Last tokens: (no turn yet)',
        ];
        if (window && lastUsage) {
          const pct = Math.round((lastUsage.prompt / window) * 100);
          lines.push(`Context: ${lastUsage.prompt} / ${window} (${pct}%)`);
        } else if (window) {
          lines.push(`Context window: ${window} tokens`);
        }
        return lines.join('\n');
      }

      case 'status': {
        const window = config.getContextWindow?.(currentModel);
        const ctxLine = window && lastUsage
          ? `${lastUsage.prompt} / ${window} (${Math.round((lastUsage.prompt / window) * 100)}%)`
          : '—';
        return [
          `Model: \`${currentModel}\``,
          `Mode: \`${mode}\``,
          `Cwd: \`${cwd}\``,
          `Turns: ${turnCount}`,
          `Context: ${ctxLine}`,
        ].join('\n');
      }

      case 'tools': {
        const lines = ['Tools available in current mode:'];
        for (const t of Object.values(TOOLS)) {
          const blocked = (mode === 'plan' && t.category !== 'read');
          const marker = blocked ? '🚫' : '✅';
          lines.push(`${marker} \`${t.name}\` (${t.category}) — ${t.description}`);
        }
        if (mode === 'plan') {
          lines.push('', '_Plan mode hides exec/write tools from the model._');
        }
        return lines.join('\n');
      }

      case 'help':
        return ['Available slash commands:', ...SLASH_COMMANDS.map((c) => `- \`/${c.name}\` — ${c.description}`)].join('\n');

      default:
        return null;
    }
  }
}
