import { describe, expect, it, vi } from 'vitest';
import * as logger from '../../server-logger';
import { COPILOT_USAGE_UPDATE, createCopilotUsageObserver, summarizeCopilotUsage } from './usage-observation';

describe('Copilot usage diagnostics', () => {
  it('retains only validated standard numeric fields and currency', () => {
    expect(summarizeCopilotUsage({ used: 42, size: 100, cost: { amount: 0.2, currency: 'USD', _meta: 'secret' } })).toEqual({
      used: { type: 'number', valid: true, value: 42 },
      size: { type: 'number', valid: true, value: 100 },
      cost: { type: 'object', amount: { type: 'number', valid: true, value: 0.2 }, currency: { type: 'string', valid: true, value: 'USD' } },
      anomalies: [],
    });
  });

  it.each([undefined, null, -1, NaN, Infinity, 1e100, 0.5, 'PRIVATE', {}, []])('bounds malformed token values (%s)', (used) => {
    const summary = summarizeCopilotUsage({ used, size: 0, cost: { amount: 'SECRET', currency: 'PRIVATE' } });
    expect(summary.anomalies).toEqual(['invalid_used', 'invalid_size', 'invalid_cost']);
    expect(summary.used).not.toHaveProperty('value');
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SECRET/);
  });

  it('distinguishes absent cost from malformed cost and reports inconsistent token counts', () => {
    expect(summarizeCopilotUsage({ used: 101, size: 100 }).anomalies).toEqual(['used_exceeds_size']);
    expect(summarizeCopilotUsage({ used: 0, size: 100, cost: null }).anomalies).toEqual([]);
    expect(summarizeCopilotUsage({ used: 0, size: 100, cost: 'PRIVATE' }).anomalies).toEqual(['invalid_cost']);
  });

  it('correlates early and late arrival without requiring a bound output sink', () => {
    const log = vi.spyOn(logger, 'serverLog').mockImplementation(() => {});
    try {
      const observer = createCopilotUsageObserver();
      const notification = { sessionId: 's1', update: { sessionUpdate: COPILOT_USAGE_UPDATE, used: 1, size: 10 } } as const;
      const settleSession = observer.beginSession();
      expect(observer.observe(notification, false)).toBe(true);
      settleSession('created', 's1');
      const settlePrompt = observer.beginPrompt('s1');
      observer.observe(notification, true);
      settlePrompt('end_turn');
      observer.observe(notification, true);
      const entries = log.mock.calls.filter((call) => call[2] === COPILOT_USAGE_UPDATE).map((call) => call[3]);
      expect(entries).toEqual([
        expect.objectContaining({ phase: 'session_pending', outputBound: false }),
        expect.objectContaining({ phase: 'prompt_pending', sessionMatches: true }),
        expect.objectContaining({ phase: 'prompt_settled', sessionMatches: true }),
      ]);
      expect(entries[1]).toHaveProperty('operationId', (entries[2] as { operationId: string }).operationId);
    } finally {
      log.mockRestore();
    }
  });
});
