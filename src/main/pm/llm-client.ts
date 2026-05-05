import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
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
  return createOpenAI({
    apiKey: config.apiKey,
    ...(meta?.baseURL ? { baseURL: meta.baseURL } : {}),
  });
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

  const result = streamText({
    model: provider(config.model),
    messages: messages as any,
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
