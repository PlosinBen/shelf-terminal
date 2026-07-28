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
    case 'item/completed':
      return translateCompletedItem(params, opts);
    case 'thread/tokenUsage/updated':
      return translateTokenUsage(params);
    case 'turn/completed':
      return [];
    case 'turn/started':
    case 'item/started':
    case 'item/updated':
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
  return [];
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
