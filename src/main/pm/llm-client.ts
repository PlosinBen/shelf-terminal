import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage } from 'ai';
import { log } from '@shared/logger';
import type { PmProviderConfig } from '@shared/types';
import { PM_PROVIDERS } from '@shared/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamEvent {
  type: 'text' | 'tool_call_start' | 'tool_call_args' | 'done';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  argsChunk?: string;
}

function buildProvider(config: PmProviderConfig) {
  const meta = PM_PROVIDERS.find((p) => p.id === config.provider);
  // User-set baseURL overrides provider default (e.g. ollama on remote host).
  // See pm-agent#10. Empty apiKey is accepted (ollama doesn't validate it,
  // spike scripts/spike-ollama.ts confirms createOpenAI tolerates '').
  const baseURL = config.baseURL ?? meta?.baseURL;
  return createOpenAI({
    apiKey: config.apiKey ?? '',
    ...(baseURL ? { baseURL } : {}),
  });
}

/**
 * Convert PM's internal OpenAI-style ChatMessage[] (which the history-store
 * persists) into ai-sdk v6's strict ModelMessage[] schema:
 *
 *  - PM ChatMessage `{role:'assistant', content:null, tool_calls:[...]}`
 *    becomes `{role:'assistant', content:[{type:'tool-call', toolCallId, toolName, input}]}`
 *  - PM ChatMessage `{role:'tool', content:'...', tool_call_id}` becomes
 *    `{role:'tool', content:[{type:'tool-result', toolCallId, toolName, output:{type:'text', value:'...'}}]}`
 *  - The system message is pulled out and returned separately so the caller
 *    can pass it via `streamText({ system, messages })` — using the dedicated
 *    `system` option also dismisses ai-sdk's prompt-injection warning.
 *
 * toolName is required by `ToolResultPart` but PM's internal tool message
 * doesn't store it, so we track `toolCallId → toolName` from preceding
 * assistant tool_calls as we walk the array. If the history is truncated
 * before the assistant message (sliding window edge case), we fall back to
 * `'unknown'` rather than throw — caller decides whether to skip the turn.
 */
export function toModelMessages(messages: ChatMessage[]): { system: string | undefined; modelMessages: ModelMessage[] } {
  let systemPrompt: string | undefined;
  const out: ModelMessage[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${msg.content}` : msg.content;
      }
      continue;
    }

    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content ?? '' });
      continue;
    }

    if (msg.role === 'assistant') {
      // Content array can hold TextPart and ToolCallPart (plus others we don't
      // emit here). Loosely typed because mixing discriminated parts wins us
      // nothing in TS — the runtime schema is what enforces shape.
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content && typeof msg.content === 'string' && msg.content.length > 0) {
        parts.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolNameByCallId.set(tc.id, tc.function.name);
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            input = {};
          }
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input,
          });
        }
      }
      // ai-sdk schema requires content non-empty. If somehow both text and
      // tool_calls are empty (shouldn't happen in PM's loop), push an
      // empty-text part as a safe fallback.
      out.push({
        role: 'assistant',
        content: (parts.length > 0 ? parts : [{ type: 'text', text: '' }]) as any,
      });
      continue;
    }

    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id ?? '';
      const toolName = toolNameByCallId.get(toolCallId) ?? 'unknown';
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName,
            output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : String(msg.content ?? '') },
          },
        ],
      });
      continue;
    }
  }

  return { system: systemPrompt, modelMessages: out };
}

export async function* streamChat(
  config: PmProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  log.debug('pm-llm', `request: ${messages.length} messages, ${tools.length} tools`);

  const provider = buildProvider(config);

  const toolMap: Record<string, { description: string; parameters: Record<string, unknown> }> = {};
  for (const t of tools) {
    toolMap[t.function.name] = {
      description: t.function.description,
      parameters: t.function.parameters,
    };
  }

  // Adapt PM's internal OpenAI-style ChatMessage[] to ai-sdk v6 ModelMessage[]
  // schema (tool_calls become content-block tool-call parts, tool result
  // content becomes a tool-result array, system pulled out). See toModelMessages.
  const { system, modelMessages } = toModelMessages(messages);

  const result = streamText({
    model: provider(config.model),
    system,
    messages: modelMessages,
    tools: Object.keys(toolMap).length > 0 ? toolMap as any : undefined,
    abortSignal: signal,
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text', text: part.text };
        break;
      case 'tool-call':
        yield { type: 'tool_call_start', toolCallId: part.toolCallId, toolName: part.toolName };
        yield { type: 'tool_call_args', toolCallId: part.toolCallId, argsChunk: JSON.stringify(part.input) };
        break;
    }
  }

  yield { type: 'done' };
}
