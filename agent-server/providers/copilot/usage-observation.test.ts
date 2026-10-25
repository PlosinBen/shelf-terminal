import { describe, expect, it, vi } from 'vitest';
import * as logger from '../../server-logger';
import { COPILOT_USAGE_UPDATE, createCopilotUsageObserver, summarizeCopilotUsage } from './usage-observation';

describe('Copilot usage diagnostics', () => {
  it('reports allowlisted credit metadata without copying unrelated values', () => {
    const summary = summarizeCopilotUsage({ used: 42, size: 100, _meta: {
      ai_credits_used: 1.25, ai_credits_remaining: 8.75,
      aiCreditsUsed: 'PRIVATE', aiCreditsRemaining: -1,
      account: 'SECRET-ACCOUNT', nested: { token: 'SECRET-TOKEN' },
    } });
    expect(summary.meta).toEqual({
      type: 'object', keyCount: 6, unrecognizedKeyCount: 2,
      credits: {
        ai_credits_used: { present: true, type: 'number', valid: true, value: 1.25 },
        ai_credits_remaining: { present: true, type: 'number', valid: true, value: 8.75 },
        aiCreditsUsed: { present: true, type: 'string', valid: false },
        aiCreditsRemaining: { present: true, type: 'number', valid: false },
      },
    });
    expect(summary.anomalies).toContain('invalid_credit_metadata');
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SECRET|account|nested|token/);
  });

  it('distinguishes missing metadata from metadata with unrecognized fields', () => {
    const absent = summarizeCopilotUsage({ used: 0, size: 100 });
    const unrecognized = summarizeCopilotUsage({ used: 0, size: 100, _meta: { private: 'SECRET' } });
    expect(absent.meta.type).toBe('undefined');
    expect(absent.meta.credits.ai_credits_used.present).toBe(false);
    expect(unrecognized.meta).toMatchObject({ type: 'object', keyCount: 1, unrecognizedKeyCount: 1 });
    expect(JSON.stringify(unrecognized)).not.toMatch(/private|SECRET/);
  });

  it('retains only validated standard numeric fields and currency', () => {
    expect(summarizeCopilotUsage({ used: 42, size: 100, cost: { amount: 0.2, currency: 'USD', _meta: 'secret' } })).toMatchObject({
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
      const notification = {
        sessionId: 's1', _meta: { aiCreditsUsed: 2.5, secret: 'PRIVATE-NOTIFICATION' },
        update: { sessionUpdate: COPILOT_USAGE_UPDATE, used: 1, size: 10, _meta: { ai_credits_remaining: 7.5, secret: 'PRIVATE-UPDATE' } },
      } as const;
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
      expect(entries[1]).toMatchObject({
        notificationMeta: { credits: { aiCreditsUsed: { present: true, value: 2.5 } } },
        meta: { credits: { ai_credits_remaining: { present: true, value: 7.5 } } },
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
    } finally {
      log.mockRestore();
    }
  });
});
