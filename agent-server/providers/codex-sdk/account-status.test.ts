import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCodexAccountStatusCacheForTests,
  fetchCodexAccountStatus,
  normalizeCodexAccountStatus,
  redactCodexAccountText,
  refreshCodexAccountStatus,
  type CodexAccountStatusSegments,
} from './account-status';
import type { LoginRpc } from '../codex-shared/app-server-login';
import type { ModelCacheClient, OutgoingMessage } from '../types';

function fakeCache() {
  const store = new Map<string, unknown>();
  const client: ModelCacheClient = {
    get: async (key) => ({ hit: store.has(key), value: store.get(key) }),
    put: (key, _provider, value) => { store.set(key, value); },
  };
  return { client, store };
}

function fakeRpc(results: Record<string, unknown>, calls: string[] = []): LoginRpc {
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push(`${method}:${JSON.stringify(params ?? null)}`);
      if (method in results) return results[method] as T;
      throw new Error(`unexpected method ${method}`);
    },
    onNotification: vi.fn(),
    close: vi.fn(() => { calls.push('close:null'); }),
  };
}

const now = () => Date.parse('2026-07-28T00:00:00.000Z');

describe('normalizeCodexAccountStatus', () => {
  it('maps rate-limit buckets and usage summary into safe status segments', () => {
    const normalized = normalizeCodexAccountStatus({
      account: { account: { email: 'ben@example.com', id: 'acct-secret' } },
      rateLimits: {
        rateLimitsByLimitId: {
          codex: {
            planType: 'prolite',
            primary: {
              usedPercent: 1,
              windowDurationMins: 10080,
              resetsAt: Date.parse('2026-08-04T00:00:00.000Z') / 1000,
            },
            credits: [{ id: 'hidden' }],
          },
          codex_bengalfox: {
            limitName: 'GPT-5.3-Codex-Spark',
            primary: { usedPercent: 82, resetsAt: '2026-07-28T02:30:00.000Z' },
          },
        },
        rateLimitResetCredits: { availableCount: 0, credits: [] },
      },
      usage: {
        summary: {
          lifetimeTokens: 88339,
          peakDailyTokens: 88339,
          longestRunningTurnSec: 1643,
          currentStreakDays: 1,
          longestStreakDays: 1,
        },
        dailyUsageBuckets: [{ startDate: '2026-07-26', tokens: 88339 }],
      },
    }, now);

    expect(normalized).toEqual({
      rateLimits: [
        { text: '7d: 1% ↻7d', severity: 'normal' },
        { text: 'GPT-5.3-Codex-Spark: 82% ↻2.5h', severity: 'critical' },
      ],
      usage: null,
    });
    expect(JSON.stringify(normalized)).not.toContain('ben@example.com');
    expect(JSON.stringify(normalized)).not.toContain('acct-secret');
  });

  it('returns null when neither quota nor usage has displayable fields', () => {
    expect(normalizeCodexAccountStatus({ account: {}, rateLimits: {}, usage: {} }, now)).toBeNull();
  });
});

describe('redactCodexAccountText', () => {
  it('redacts email, token-looking fields, and account ids', () => {
    const text = redactCodexAccountText('user ben@example.com access_token: abc.def account_id=acct_123 org-id org_456');
    expect(text).not.toContain('ben@example.com');
    expect(text).not.toContain('abc.def');
    expect(text).not.toContain('acct_123');
    expect(text).toContain('<redacted-email>');
    expect(text).toContain('<redacted-token>');
    expect(text).toContain('<redacted-id>');
  });
});

describe('fetchCodexAccountStatus', () => {
  it('initializes app-server, reads account/rate limits/usage, and closes rpc', async () => {
    const calls: string[] = [];
    const rpc = fakeRpc({
      initialize: { ok: true },
      'account/read': { account: { email: 'ben@example.com' } },
      'account/rateLimits/read': { rateLimitsByLimitId: {} },
      'account/usage/read': { summary: { lifetimeTokens: 1 } },
    }, calls);

    const result = await fetchCodexAccountStatus('app-1', () => ({ rpc }));

    expect(result).toEqual({
      account: { account: { email: 'ben@example.com' } },
      rateLimits: { rateLimitsByLimitId: {} },
      usage: { summary: { lifetimeTokens: 1 } },
    });
    expect(calls[0]).toMatch(/^initialize:/);
    expect(calls).toContain('account/read:{"refreshToken":false}');
    expect(calls).toContain('account/rateLimits/read:null');
    expect(calls).toContain('account/usage/read:null');
    expect(calls.at(-1)).toBe('close:null');
  });

  it('returns null without an app id and does not spawn', async () => {
    const spawn = vi.fn();
    await expect(fetchCodexAccountStatus(undefined, spawn)).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('refreshCodexAccountStatus', () => {
  const segments: CodexAccountStatusSegments = {
    rateLimits: [{ text: '7d: 1%', severity: 'normal' }],
    usage: null,
  };

  beforeEach(() => __resetCodexAccountStatusCacheForTests());

  it('cache MISS → fetch, cache, send turnId-less status', async () => {
    const { client, store } = fakeCache();
    const sent: OutgoingMessage[] = [];
    const fetch = vi.fn(async () => segments);

    await refreshCodexAccountStatus(client, (m) => sent.push(m), 'app-1', () => 1000, fetch);

    expect(fetch).toHaveBeenCalledOnce();
    expect(store.get('account-status')).toEqual({ segments, fetchedAt: 1000 });
    expect(sent).toEqual([{ type: 'status', rateLimits: segments.rateLimits }]);
  });

  it('fresh cache HIT → sends cached status without fetch', async () => {
    const { client } = fakeCache();
    client.put('account-status', 'codex-offical', { segments, fetchedAt: 1000 });
    const sent: OutgoingMessage[] = [];
    const fetch = vi.fn(async () => segments);

    await refreshCodexAccountStatus(client, (m) => sent.push(m), 'app-1', () => 1000 + 60_000, fetch);

    expect(fetch).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'status', rateLimits: segments.rateLimits }]);
  });

  it('null result is cached and sends nothing', async () => {
    const { client, store } = fakeCache();
    const sent: OutgoingMessage[] = [];

    await refreshCodexAccountStatus(client, (m) => sent.push(m), 'app-1', () => 1000, async () => null);

    expect(store.get('account-status')).toEqual({ segments: null, fetchedAt: 1000 });
    expect(sent).toEqual([]);
  });

  it('without dispatcher cache uses process-local fallback', async () => {
    const sent: OutgoingMessage[] = [];
    const fetch = vi.fn(async () => segments);

    await refreshCodexAccountStatus(undefined, (m) => sent.push(m), 'app-1', () => 1000, fetch);
    await refreshCodexAccountStatus(undefined, (m) => sent.push(m), 'app-1', () => 1000 + 60_000, fetch);

    expect(fetch).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
  });

  it('is fail-quiet when fetch throws', async () => {
    const sent: OutgoingMessage[] = [];
    await expect(
      refreshCodexAccountStatus(undefined, (m) => sent.push(m), 'app-1', () => 1000, async () => { throw new Error('ben@example.com access_token: secret'); }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });
});
