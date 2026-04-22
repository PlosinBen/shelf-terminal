import { net } from 'electron';
import { log } from '@shared/logger';
import type { PmProviderConfig } from '@shared/types';

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

export async function* streamChat(
  config: PmProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const body = JSON.stringify({
    model: config.model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
  });

  log.debug('pm-llm', `request: ${messages.length} messages, ${tools.length} tools`);

  const resp = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${text}`);
  }

  if (!resp.body) throw new Error('No response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: 'text', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              yield { type: 'tool_call_start', toolCallId: tc.id, toolName: tc.function?.name };
            }
            if (tc.function?.arguments) {
              yield { type: 'tool_call_args', toolCallId: tc.id, argsChunk: tc.function.arguments };
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done' };
}
