import type { AgentBackend, AgentEvent, AgentMessagePayload, AgentQueryOptions } from '../types';
import type { Query, SDKMessage, Options, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { log } from '@shared/logger';

let sdkQuery: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;

async function loadSdk() {
  if (!sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export function createClaudeBackend(): AgentBackend {
  let activeQuery: Query | null = null;
  let abortController: AbortController | null = null;

  return {
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      const queryFn = await loadSdk();
      abortController = new AbortController();

      const options: Options = {
        abortController,
        cwd,
        tools: { type: 'preset', preset: 'claude_code' },
        thinking: { type: 'adaptive' },
        includePartialMessages: true,
        permissionMode: (opts?.permissionMode as Options['permissionMode']) ?? 'default',
      };

      if (opts?.resume) {
        options.resume = opts.resume;
      }

      if (opts?.canUseTool) {
        const userCallback = opts.canUseTool;
        options.canUseTool = (async (toolName, input, canUseOpts) => {
          const result = await userCallback(canUseOpts.toolUseID, toolName, input);
          if (result.behavior === 'allow') {
            return { behavior: 'allow' as const };
          }
          return { behavior: 'deny' as const, message: result.message ?? 'Denied by user' };
        }) as CanUseTool;
      }

      activeQuery = queryFn({ prompt, options });

      try {
        for await (const msg of activeQuery) {
          const events = processMessage(msg);
          for (const event of events) {
            yield event;
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          log.error('claude-backend', 'Query error:', err.message);
          yield { type: 'error', error: err.message ?? 'Unknown error' };
        }
      } finally {
        activeQuery = null;
        abortController = null;
      }
    },

    async stop() {
      if (activeQuery) {
        try {
          await activeQuery.interrupt();
        } catch {
          abortController?.abort();
        }
      }
    },

    dispose() {
      abortController?.abort();
      activeQuery = null;
      abortController = null;
    },

    async getSlashCommands() {
      if (!activeQuery) return [];
      try {
        const cmds = await activeQuery.supportedCommands();
        return cmds.map((c) => ({ name: c.name, description: c.description }));
      } catch {
        return [];
      }
    },
  };
}

function processMessage(msg: SDKMessage): AgentEvent[] {
  const events: AgentEvent[] = [];

  switch (msg.type) {
    case 'assistant': {
      const content = msg.message.content;
      for (const block of content) {
        if (block.type === 'thinking') {
          events.push({
            type: 'message',
            payload: { type: 'thinking', content: block.thinking, sessionId: msg.session_id },
          });
        } else if (block.type === 'text') {
          events.push({
            type: 'message',
            payload: { type: 'text', content: block.text, sessionId: msg.session_id },
          });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'message',
            payload: {
              type: 'tool_use',
              content: '',
              toolName: block.name,
              toolInput: block.input as Record<string, unknown>,
              toolUseId: block.id,
              parentToolUseId: msg.parent_tool_use_id ?? undefined,
              sessionId: msg.session_id,
            },
          });
        }
      }

      if (msg.message.usage) {
        events.push({
          type: 'status',
          payload: {
            state: 'streaming',
            model: msg.message.model,
            inputTokens: msg.message.usage.input_tokens,
            outputTokens: msg.message.usage.output_tokens,
            sessionId: msg.session_id,
          },
        });
      }
      break;
    }

    case 'user': {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ((block as any).type === 'tool_result') {
            events.push({
              type: 'message',
              payload: {
                type: 'tool_result',
                content: typeof (block as any).content === 'string'
                  ? (block as any).content
                  : JSON.stringify((block as any).content ?? ''),
                toolUseId: (block as any).tool_use_id,
                sessionId: msg.session_id,
              },
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const resultText = msg.subtype === 'success' ? msg.result : (msg.errors?.join('\n') ?? 'Error');
      const cost = msg.subtype === 'success' ? msg.total_cost_usd : undefined;
      const usage = msg.subtype === 'success' ? msg.usage : undefined;
      const numTurns = msg.subtype === 'success' ? msg.num_turns : undefined;
      const payload: AgentMessagePayload = {
        type: 'result',
        content: resultText,
        sessionId: msg.session_id,
        costUsd: cost,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
      events.push({ type: 'message', payload });
      events.push({
        type: 'status',
        payload: {
          state: 'idle',
          costUsd: cost,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          numTurns,
          sessionId: msg.session_id,
        },
      });
      break;
    }

    case 'rate_limit_event': {
      events.push({
        type: 'status',
        payload: {
          state: 'streaming',
          sessionId: msg.session_id,
          rateLimit: {
            rateLimitType: msg.rate_limit_info.rateLimitType,
            status: msg.rate_limit_info.status,
            utilization: msg.rate_limit_info.utilization,
            resetsAt: msg.rate_limit_info.resetsAt,
          },
        },
      });
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        events.push({
          type: 'message',
          payload: { type: 'system', content: `Model: ${msg.model}`, sessionId: msg.session_id },
        });
        events.push({
          type: 'status',
          payload: { state: 'streaming', model: msg.model, sessionId: msg.session_id },
        });
      }
      break;
    }

    default:
      break;
  }

  return events;
}
