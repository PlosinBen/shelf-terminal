import { randomUUID } from 'node:crypto';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { serverLog } from '../../server-logger';

export const COPILOT_USAGE_UPDATE = 'usage_update';
export const COPILOT_USAGE_LOG_TAG = 'copilot-usage';

function valueType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function numberField(value: unknown, integer: boolean, positive = false) {
  const valid = typeof value === 'number' && Number.isFinite(value)
    && value <= Number.MAX_SAFE_INTEGER && (positive ? value > 0 : value >= 0)
    && (!integer || Number.isSafeInteger(value));
  return { type: valueType(value), valid, ...(valid ? { value: value as number } : {}) };
}

/** Never copy arbitrary payload values into diagnostics, including malformed strings. */
export function summarizeCopilotUsage(update: { used?: unknown; size?: unknown; cost?: unknown }) {
  const used = numberField(update.used, true);
  const size = numberField(update.size, true, true);
  const cost = update.cost;
  const costObject = typeof cost === 'object' && cost !== null && !Array.isArray(cost)
    ? cost as Record<string, unknown> : undefined;
  const amount = numberField(costObject?.amount, false);
  const currency = costObject?.currency;
  const currencyValid = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
  const anomalies: string[] = [];
  if (!used.valid) anomalies.push('invalid_used');
  if (!size.valid) anomalies.push('invalid_size');
  if (used.valid && size.valid && used.value! > size.value!) anomalies.push('used_exceeds_size');
  if (cost != null && (!costObject || !amount.valid || !currencyValid)) anomalies.push('invalid_cost');
  return {
    used,
    size,
    cost: {
      type: valueType(cost),
      ...(costObject ? {
        amount,
        currency: { type: valueType(currency), valid: currencyValid, ...(currencyValid ? { value: currency } : {}) },
      } : {}),
    },
    anomalies,
  };
}

/** Session/prompt markers make a completed no-event observation distinguishable from lost logs.
 * Timing describes arrival relative to Shelf operations, never ownership of provider content. */
export function createCopilotUsageObserver() {
  let operation: { id: string; kind: 'session' | 'prompt'; startedAt: number; settled: boolean; sessionId?: string } | undefined;

  function begin(kind: 'session' | 'prompt', sessionId?: string) {
    const current = { id: randomUUID(), kind, sessionId, startedAt: Date.now(), settled: false };
    operation = current;
    serverLog('info', COPILOT_USAGE_LOG_TAG, `${kind}_started`, { operationId: current.id, sessionId });
    return (result: string, establishedSessionId?: string) => {
      current.settled = true;
      current.sessionId = establishedSessionId ?? current.sessionId;
      serverLog('info', COPILOT_USAGE_LOG_TAG, `${kind}_settled`, {
        operationId: current.id, sessionId: current.sessionId, result,
        elapsedMs: Date.now() - current.startedAt,
      });
    };
  }

  return {
    beginSession: (sessionId?: string) => begin('session', sessionId),
    beginPrompt: (sessionId: string) => begin('prompt', sessionId),
    observe(notification: SessionNotification, outputBound: boolean): boolean {
      if (notification.update.sessionUpdate !== COPILOT_USAGE_UPDATE) return false;
      const summary = summarizeCopilotUsage(notification.update);
      serverLog(summary.anomalies.length ? 'warn' : 'info', COPILOT_USAGE_LOG_TAG, COPILOT_USAGE_UPDATE, {
        sessionId: notification.sessionId,
        operationId: operation?.id,
        phase: operation ? `${operation.kind}_${operation.settled ? 'settled' : 'pending'}` : 'before_session',
        elapsedMs: operation ? Date.now() - operation.startedAt : undefined,
        sessionMatches: operation?.sessionId === undefined ? undefined : operation.sessionId === notification.sessionId,
        outputBound,
        ...summary,
      });
      return true;
    },
  };
}
