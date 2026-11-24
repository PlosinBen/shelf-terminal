import type { OutgoingMessage, StatusSegment } from '../types';
import { serverLog } from '../../server-logger';
import { fileChangesToMessages } from './file-changes';
import { EXECUTION_STATE as ES, type AgentExecution } from '@shared/agent-execution';

export const CODEX_PLAN_UPDATED = 'turn/plan/updated';
const PLAN_STATUS_MARKERS = { pending: '[ ]', inProgress: '[~]', completed: '[x]' } as const;

export interface CodexAppServerTranslateOptions {
  redactValues?: string[];
  cwd?: string;
}

export function translateCodexAppServerNotification(
  method: string,
  params: unknown,
  opts: CodexAppServerTranslateOptions = {},
): OutgoingMessage[] {
  switch (method) {
    case CODEX_PLAN_UPDATED:
      return translatePlanUpdate(params, opts);
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

function translatePlanUpdate(params: unknown, opts: CodexAppServerTranslateOptions): OutgoingMessage[] {
  const payload = asRecord(params);
  const plan = payload?.plan;
  const lines: string[] = [];
  if (Array.isArray(plan)) {
    for (const raw of plan) {
      const entry = asRecord(raw);
      const status = entry?.status;
      if (typeof entry?.step !== 'string' || typeof status !== 'string' || !Object.hasOwn(PLAN_STATUS_MARKERS, status)) break;
      lines.push(`- ${PLAN_STATUS_MARKERS[status as keyof typeof PLAN_STATUS_MARKERS]} ${entry.step}`);
    }
    if (lines.length === plan.length) {
      return [{ type: 'plan', content: redactText(lines.join('\n'), opts.redactValues) }];
    }
  }
  // Reject the entire malformed snapshot; never silently clear/partially replace a valid plan.
  serverLog('warn', 'codex-app-server', 'Invalid turn plan snapshot', {
    threadId: stringValue(payload?.threadId), turnId: stringValue(payload?.turnId),
    entryCount: Array.isArray(plan) ? plan.length : null,
  });
  return [];
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
    if (!text.trim()) return [];
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
    return fileChangeToMessages(id, item, opts);
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
      msgType: 'fold_markdown',
      label: 'Web search',
      subtitle: redactText(query, opts.redactValues),
    }] : [];
  }
  return [];
}

function commandExecutionToMessage(id: string, item: Record<string, unknown>, opts: CodexAppServerTranslateOptions): OutgoingMessage {
  const status = stringValue(item.status);
  const command = stringValue(item.command) ?? 'command';
  const output = stringValue(item.aggregatedOutput ?? item.aggregated_output) ?? '';
  const exitCode = numberValue(item.exitCode ?? item.exit_code);
  const validExit = typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 2147483647;
  let state: AgentExecution['state'] = ES.UNKNOWN;
  if (status === 'inProgress') state = ES.RUNNING;
  if (status === 'completed' && validExit) state = exitCode !== 0 ? ES.FAILED : ES.SUCCEEDED;
  if (status === 'failed') state = ES.FAILED;
  if (status === 'declined') state = ES.DECLINED;
  const contradictory = (status === 'completed' && validExit && exitCode !== 0)
    || (status === 'failed' && exitCode === 0)
    || ((state === ES.RUNNING || state === ES.DECLINED) && validExit);
  if ((state === ES.RUNNING || state === ES.DECLINED) && validExit) state = ES.UNKNOWN;
  const rawExit = item.exitCode ?? item.exit_code;
  if (state === ES.UNKNOWN || contradictory || (rawExit != null && !validExit)) {
    serverLog('warn', 'codex-command', 'Unexpected command outcome', { itemId: id, status, exitCode });
    if (rawExit != null && !validExit) state = ES.UNKNOWN;
  }
  const settled = status === 'completed' || status === 'failed' || status === 'declined';
  const bodyContent = output || (settled ? '(no output)' : '');
  return {
    type: 'message',
    msgId: id,
    msgType: 'fold_code',
    label: 'Command',
    execution: { state, ...(validExit ? { exitCode } : {}) },
    subtitle: redactText(command, opts.redactValues),
    ...(state === ES.FAILED && (!validExit || exitCode === 0)
      ? { errorMessage: validExit ? 'Command reported failure despite exit code 0' : 'Command failed (exit code unavailable)' } : {}),
    ...(bodyContent
      ? { body: { content: redactText(bodyContent, opts.redactValues) } }
      : {}),
  };
}

function fileChangeToMessages(id: string, item: Record<string, unknown>, opts: CodexAppServerTranslateOptions): OutgoingMessage[] {
  const result = fileChangesToMessages(id, item, opts.cwd);
  for (const diagnostic of result.diagnostics) {
    serverLog(diagnostic.level, 'codex-file-change', redactText(JSON.stringify(diagnostic), opts.redactValues));
  }
  // Preserve hunk row counts even when an explicitly redacted value spans lines.
  const redactLines = (lines: string[]) => {
    if (!lines.length) return [];
    let content = lines.join('\n');
    for (const value of opts.redactValues ?? []) {
      if (value) content = content.split(value).join(value.split('\n').map(() => '[REDACTED]').join('\n'));
    }
    return content.split('\n');
  };
  return result.messages.map(message => {
    if (message.type !== 'message') return message;
    if (message.msgType === 'fold_diff' && message.body && 'hunks' in message.body.diff) {
      return { ...message, subtitle: redactText(message.subtitle ?? '', opts.redactValues), body: { diff: {
        hunks: message.body.diff.hunks.map(hunk => ({ ...hunk, oldLines: redactLines(hunk.oldLines), newLines: redactLines(hunk.newLines) })),
      } } };
    }
    if (message.msgType === 'fold_markdown' || message.msgType === 'fold_code') {
      return { ...message, ...(message.subtitle ? { subtitle: redactText(message.subtitle, opts.redactValues) } : {}),
        ...(message.body ? { body: { content: redactText(message.body.content, opts.redactValues) } } : {}),
      };
    }
    return message;
  });
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
