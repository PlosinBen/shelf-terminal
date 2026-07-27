import type { McpToolCallItem, ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { OutgoingMessage } from '../types';

export interface CodexTranslateOptions {
  redactValues?: string[];
}

export function translateCodexThreadEvent(
  event: ThreadEvent,
  opts: CodexTranslateOptions = {},
): OutgoingMessage[] {
  switch (event.type) {
    case 'thread.started':
      return [
        { type: 'context_patch', patch: { lastSdkSessionId: event.thread_id } },
        { type: 'status', state: 'streaming', sessionId: event.thread_id },
      ];
    case 'turn.started':
      return [];
    case 'turn.completed':
      return [usageToStatus(event.usage)];
    case 'turn.failed':
      return [{ type: 'error', error: `codex: ${redactText(event.error.message, opts.redactValues)}` }];
    case 'error':
      return [{ type: 'error', error: `codex: ${redactText(event.message, opts.redactValues)}` }];
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return translateCodexThreadItem(event.item, opts);
    default:
      return [{ type: 'error', error: `codex: unsupported SDK event type "${String((event as { type?: unknown }).type)}"` }];
  }
}

export function translateCodexThreadItem(
  item: ThreadItem,
  opts: CodexTranslateOptions = {},
): OutgoingMessage[] {
  switch (item.type) {
    case 'agent_message':
      return [{
        type: 'message',
        msgId: item.id,
        msgType: 'reply',
        content: redactText(item.text, opts.redactValues),
      }];
    case 'reasoning':
      return [{
        type: 'message',
        msgId: item.id,
        msgType: 'fold_text',
        label: 'Reasoning',
        body: { content: redactText(item.text, opts.redactValues), tone: 'muted' },
      }];
    case 'command_execution':
      return [{
        type: 'message',
        msgId: item.id,
        msgType: 'fold_code',
        label: 'Command',
        subtitle: redactText(item.command, opts.redactValues),
        ...(item.status === 'failed' ? { errorMessage: `Command failed with exit code ${item.exit_code ?? 'unknown'}` } : {}),
        ...((item.aggregated_output || item.status === 'completed' || item.status === 'failed')
          ? { body: { content: redactText(item.aggregated_output, opts.redactValues) } }
          : {}),
      }];
    case 'file_change':
      return [{
        type: 'message',
        msgId: item.id,
        msgType: 'fold_markdown',
        label: 'File changes',
        ...(item.status === 'failed' ? { errorMessage: 'File change failed' } : {}),
        body: { content: redactText(renderFileChanges(item.changes), opts.redactValues) },
      }];
    case 'mcp_tool_call':
      return [mcpToolCallToMessage(item, opts)];
    case 'web_search':
      return [{
        type: 'message',
        msgId: item.id,
        msgType: 'note',
        content: `Web search: ${redactText(item.query, opts.redactValues)}`,
      }];
    case 'todo_list':
      return [{ type: 'plan', content: redactText(renderCodexTodoList(item.items), opts.redactValues) }];
    case 'error':
      return [{
        type: 'message',
        msgId: item.id,
        msgType: 'error',
        content: redactText(item.message, opts.redactValues),
      }];
    default:
      return [{ type: 'error', error: `codex: unsupported SDK item type "${String((item as { type?: unknown }).type)}"` }];
  }
}

export function renderCodexTodoList(items: Extract<ThreadItem, { type: 'todo_list' }>['items']): string {
  return items.map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`).join('\n');
}

function usageToStatus(usage: Usage): OutgoingMessage {
  return {
    type: 'status',
    state: 'streaming',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

function renderFileChanges(changes: Array<{ path: string; kind: string }>): string {
  return changes.map((change) => `- ${change.kind} \`${change.path}\``).join('\n');
}

function mcpToolCallToMessage(item: McpToolCallItem, opts: CodexTranslateOptions): OutgoingMessage {
  const contentParts: string[] = [];
  contentParts.push('Arguments:');
  contentParts.push('```json');
  contentParts.push(redactText(formatJson(item.arguments), opts.redactValues));
  contentParts.push('```');
  const resultText = mcpResultText(item.result?.content);
  if (resultText) {
    contentParts.push('');
    contentParts.push('Result:');
    contentParts.push(redactText(resultText, opts.redactValues));
  }
  return {
    type: 'message',
    msgId: item.id,
    msgType: 'fold_markdown',
    label: 'MCP tool',
    subtitle: `${item.server}.${item.tool}`,
    ...(item.status === 'failed' ? { errorMessage: redactText(item.error?.message ?? 'MCP tool call failed', opts.redactValues) } : {}),
    ...((contentParts.length || item.status === 'completed' || item.status === 'failed')
      ? { body: { content: contentParts.join('\n') } }
      : {}),
  };
}

function mcpResultText(content: ContentBlock[] | undefined): string {
  if (!content?.length) return '';
  return content.map(contentBlockToText).filter(Boolean).join('\n');
}

function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return block.uri ? `[${block.name ?? block.uri}](${block.uri})` : (block.name ?? '');
    case 'resource': {
      const resource = block.resource as { text?: unknown };
      return typeof resource.text === 'string' ? resource.text : '';
    }
    case 'image':
    case 'audio':
      return '';
    default:
      return '';
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

function redactText(text: string, values: string[] | undefined): string {
  let out = text;
  for (const value of values ?? []) {
    if (!value) continue;
    out = out.split(value).join('[REDACTED]');
  }
  return out;
}
