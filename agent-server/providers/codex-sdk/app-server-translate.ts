import type { OutgoingMessage, StatusSegment } from '../types';

export interface CodexAppServerTranslateOptions {
  redactValues?: string[];
}

export function translateCodexAppServerNotification(
  method: string,
  params: unknown,
  opts: CodexAppServerTranslateOptions = {},
): OutgoingMessage[] {
  switch (method) {
    case 'thread/status/changed':
      return translateThreadStatus(params);
    case 'item/agentMessage/delta':
      return translateAgentMessageDelta(params, opts);
    case 'item/started':
    case 'item/updated':
    case 'item/completed':
      return translateCompletedItem(params, opts);
    case 'thread/tokenUsage/updated':
      return translateTokenUsage(params);
    case 'turn/completed':
      return [];
    case 'turn/started':
    case 'account/rateLimits/updated':
    case 'mcpServer/startupStatus/updated':
      return [];
    default:
      return [];
  }
}

export function tokenUsageToContextSegment(raw: unknown): StatusSegment | null {
  const summary = summarizeTokenUsageForLog(raw);
  if (!summary) return null;
  const contextTokens = summary.lastTotalTokens ?? summary.lastInputTokens;
  if (contextTokens == null) return null;
  const percent = Math.max(0, Math.min(100, Math.round((contextTokens / summary.modelContextWindow) * 100)));
  return {
    text: `ctx: ${percent}%`,
    severity: percent >= 80 ? 'critical' : percent >= 50 ? 'warning' : 'normal',
  };
}

export function summarizeTokenUsageForLog(raw: unknown): {
  cumulativeTotalTokens: number | null;
  lastInputTokens: number | null;
  lastTotalTokens: number | null;
  modelContextWindow: number;
  cumulativePercent: number | null;
  lastPercent: number | null;
} | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const total = asRecord(usage.total) ?? usage;
  const last = asRecord(usage.last);
  const cumulative = numberValue(total.totalTokens ?? total.total_tokens);
  const lastInput = numberValue(last?.inputTokens ?? last?.input_tokens);
  const lastTotal = numberValue(last?.totalTokens ?? last?.total_tokens);
  const size = numberValue(usage.modelContextWindow ?? usage.model_context_window);
  if (size == null || size <= 0) return null;
  return {
    cumulativeTotalTokens: cumulative,
    lastInputTokens: lastInput,
    lastTotalTokens: lastTotal,
    modelContextWindow: size,
    cumulativePercent: cumulative == null ? null : percent(cumulative, size),
    lastPercent: lastTotal == null ? null : percent(lastTotal, size),
  };
}

function percent(tokens: number, window: number): number {
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

function translateThreadStatus(params: unknown): OutgoingMessage[] {
  const p = asRecord(params);
  const status = asRecord(p?.threadStatus) ?? asRecord(p?.thread_status) ?? p;
  const state = status?.status;
  if (state === 'running') return [{ type: 'status', state: 'streaming' }];
  if (state === 'idle') return [{ type: 'status', state: 'idle' }];
  return [];
}

function translateAgentMessageDelta(params: unknown, opts: CodexAppServerTranslateOptions): OutgoingMessage[] {
  const p = asRecord(params);
  const msgId = stringValue(p?.itemId ?? p?.item_id ?? p?.id);
  const delta = stringValue(p?.delta ?? p?.textDelta ?? p?.text_delta ?? p?.text);
  if (!msgId || !delta) return [];
  return [{
    type: 'stream',
    msgId,
    streamType: 'text',
    content: redactText(delta, opts.redactValues),
  }];
}

function translateCompletedItem(params: unknown, opts: CodexAppServerTranslateOptions): OutgoingMessage[] {
  const item = asRecord(asRecord(params)?.item);
  if (!item) return [];
  const id = stringValue(item.id);
  if (!id) return [];
  const itemType = stringValue(item.type);
  if (itemType === 'agentMessage' || itemType === 'agent_message') {
    const text = stringValue(item.text) ?? collectText(item.content);
    return [{
      type: 'message',
      msgId: id,
      msgType: 'reply',
      content: redactText(text ?? '', opts.redactValues),
    }];
  }
  if (itemType === 'contextCompaction') {
    return [{
      type: 'message',
      msgId: id,
      msgType: 'system',
      content: 'Context compacted.',
    }];
  }
  if (itemType === 'reasoning') {
    const text = asArray(item.summary).map(stringValue).filter((value): value is string => !!value).join('\n')
      || asArray(item.content).map(stringValue).filter((value): value is string => !!value).join('\n');
    return [{
      type: 'message',
      msgId: id,
      msgType: 'fold_text',
      label: 'Reasoning',
      body: { content: redactText(text, opts.redactValues), tone: 'muted' },
    }];
  }
  if (itemType === 'plan') {
    const text = stringValue(item.text);
    return text ? [{ type: 'plan', content: redactText(text, opts.redactValues) }] : [];
  }
  if (itemType === 'commandExecution' || itemType === 'command_execution') {
    return [commandExecutionToMessage(id, item, opts)];
  }
  if (itemType === 'fileChange' || itemType === 'file_change') {
    return [fileChangeToMessage(id, item, opts)];
  }
  if (itemType === 'mcpToolCall' || itemType === 'mcp_tool_call') {
    return [mcpToolCallToMessage(id, item, opts)];
  }
  if (itemType === 'dynamicToolCall' || itemType === 'dynamic_tool_call') {
    return [dynamicToolCallToMessage(id, item, opts)];
  }
  if (itemType === 'webSearch' || itemType === 'web_search') {
    const query = stringValue(item.query);
    return query ? [{
      type: 'message',
      msgId: id,
      msgType: 'note',
      content: `Web search: ${redactText(query, opts.redactValues)}`,
    }] : [];
  }
  return [];
}

function commandExecutionToMessage(id: string, item: Record<string, unknown>, opts: CodexAppServerTranslateOptions): OutgoingMessage {
  const status = stringValue(item.status);
  const command = stringValue(item.command) ?? 'command';
  const output = stringValue(item.aggregatedOutput ?? item.aggregated_output) ?? '';
  const exitCode = numberValue(item.exitCode ?? item.exit_code);
  return {
    type: 'message',
    msgId: id,
    msgType: 'fold_code',
    label: 'Command',
    subtitle: redactText(command, opts.redactValues),
    ...(status === 'failed' ? { errorMessage: `Command failed with exit code ${exitCode ?? 'unknown'}` } : {}),
    ...((output || status === 'completed' || status === 'failed' || status === 'declined')
      ? { body: { content: redactText(output, opts.redactValues) } }
      : {}),
  };
}

function fileChangeToMessage(id: string, item: Record<string, unknown>, opts: CodexAppServerTranslateOptions): OutgoingMessage {
  const status = stringValue(item.status);
  const diff = singleFileDiff(item.changes);
  if (diff) {
    return {
      type: 'message',
      msgId: id,
      msgType: 'fold_diff',
      label: 'File changes',
      subtitle: redactText(diff.path, opts.redactValues),
      ...(status === 'failed' ? { errorMessage: 'File change failed' } : {}),
      ...(status === 'declined' ? { errorMessage: 'File change declined' } : {}),
      body: { diff: { oldString: redactText(diff.oldString, opts.redactValues), newString: redactText(diff.newString, opts.redactValues) } },
    };
  }
  return {
    type: 'message',
    msgId: id,
    msgType: 'fold_markdown',
    label: 'File changes',
    ...(status === 'failed' ? { errorMessage: 'File change failed' } : {}),
    ...(status === 'declined' ? { errorMessage: 'File change declined' } : {}),
    body: { content: redactText(renderFileChanges(item.changes), opts.redactValues) },
  };
}

function singleFileDiff(raw: unknown): { path: string; oldString: string; newString: string } | null {
  const changes = asArray(raw).map(asRecord).filter((value): value is Record<string, unknown> => !!value);
  if (changes.length !== 1) return null;
  const change = changes[0];
  const path = stringValue(change.path) ?? 'unknown';
  const parsed = parseUnifiedDiff(stringValue(change.diff) ?? '');
  return parsed ? { path, ...parsed } : null;
}

function parseUnifiedDiff(diff: string): { oldString: string; newString: string } | null {
  if (!diff.trim() || !/^@@\s/m.test(diff)) return null;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ')) {
      const text = line.slice(1);
      oldLines.push(text);
      newLines.push(text);
      continue;
    }
    if (line === '\\ No newline at end of file') continue;
    // Some app-server snapshots contain raw file content instead of unified diff.
    return null;
  }
  return { oldString: oldLines.join('\n'), newString: newLines.join('\n') };
}

function renderFileChanges(raw: unknown): string {
  const lines: string[] = [];
  for (const entry of asArray(raw)) {
    const change = asRecord(entry);
    const path = stringValue(change?.path) ?? 'unknown';
    const kind = stringValue(change?.kind) ?? 'change';
    const diff = stringValue(change?.diff);
    lines.push(`- ${kind} \`${path}\``);
    if (diff?.trim()) lines.push(`\`\`\`diff\n${diff}\n\`\`\``);
  }
  return lines.join('\n');
}

function mcpToolCallToMessage(id: string, item: Record<string, unknown>, opts: CodexAppServerTranslateOptions): OutgoingMessage {
  const server = stringValue(item.server) ?? 'mcp';
  const tool = stringValue(item.tool) ?? 'tool';
  const status = stringValue(item.status);
  const contentParts = renderArgsAndOutput(item.arguments, mcpResultText(asRecord(item.result)?.content), 'Result', opts);
  const error = stringValue(asRecord(item.error)?.message) ?? 'MCP tool call failed';
  return {
    type: 'message',
    msgId: id,
    msgType: 'fold_markdown',
    label: 'MCP tool',
    subtitle: `${server}.${tool}`,
    ...(status === 'failed' ? { errorMessage: redactText(error, opts.redactValues) } : {}),
    ...((contentParts || status === 'completed' || status === 'failed') ? { body: { content: contentParts } } : {}),
  };
}

function dynamicToolCallToMessage(id: string, item: Record<string, unknown>, opts: CodexAppServerTranslateOptions): OutgoingMessage {
  const namespace = stringValue(item.namespace);
  const tool = stringValue(item.tool) ?? 'tool';
  const status = stringValue(item.status);
  const contentParts = renderArgsAndOutput(item.arguments, dynamicToolOutputText(item.contentItems ?? item.content_items), 'Output', opts);
  return {
    type: 'message',
    msgId: id,
    msgType: 'fold_markdown',
    label: 'Tool',
    subtitle: namespace ? `${namespace}.${tool}` : tool,
    ...(status === 'failed' || item.success === false ? { errorMessage: 'Tool call failed' } : {}),
    ...((contentParts || status === 'completed' || status === 'failed') ? { body: { content: contentParts } } : {}),
  };
}

function renderArgsAndOutput(args: unknown, output: string, outputHeading: string, opts: CodexAppServerTranslateOptions): string {
  const contentParts: string[] = [];
  contentParts.push('Arguments:');
  contentParts.push('```json');
  contentParts.push(redactText(formatJson(args), opts.redactValues));
  contentParts.push('```');
  if (output) {
    contentParts.push('');
    contentParts.push(`${outputHeading}:`);
    contentParts.push(redactText(output, opts.redactValues));
  }
  return contentParts.join('\n');
}

function mcpResultText(raw: unknown): string {
  return asArray(raw).map(contentBlockToText).filter(Boolean).join('\n');
}

function dynamicToolOutputText(raw: unknown): string {
  return asArray(raw)
    .map((entry) => stringValue(asRecord(entry)?.text) ?? stringValue(asRecord(entry)?.imageUrl) ?? stringValue(asRecord(entry)?.audioUrl))
    .filter((value): value is string => !!value)
    .join('\n');
}

function contentBlockToText(raw: unknown): string {
  const block = asRecord(raw);
  if (!block) return '';
  if (block.type === 'text') return stringValue(block.text) ?? '';
  if (block.type === 'resource_link') return stringValue(block.uri) ?? stringValue(block.name) ?? '';
  const resource = asRecord(block.resource);
  if (block.type === 'resource' && typeof resource?.text === 'string') return resource.text;
  return '';
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

function translateTokenUsage(params: unknown): OutgoingMessage[] {
  const p = asRecord(params);
  const segment = tokenUsageToContextSegment(p?.tokenUsage ?? p?.token_usage ?? p);
  return segment ? [{ type: 'status', state: 'streaming', contextUsage: segment }] : [];
}

function collectText(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const text = raw
    .map((entry) => stringValue(asRecord(entry)?.text))
    .filter((entry): entry is string => !!entry)
    .join('');
  return text || null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function redactText(text: string, values: string[] | undefined): string {
  let out = text;
  for (const value of values ?? []) {
    if (!value) continue;
    out = out.split(value).join('[REDACTED]');
  }
  return out;
}
