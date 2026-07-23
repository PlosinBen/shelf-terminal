import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeCredit, refreshCopilotCredit, __resetCreditCacheForTests } from './credit';
import type { ModelCacheClient, OutgoingMessage, StatusSegment } from '../types';

function fakeCache() {
  const store = new Map<string, unknown>();
  const client: ModelCacheClient = {
    get: async (key: string) => ({ hit: store.has(key), value: store.get(key) }),
    put: (key: string, _provider: string, value: unknown) => { store.set(key, value); },
  };
  return { client, store };
}

const snap = (over: Record<string, unknown> = {}) =>
  ({ quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, usedRequests: 10327, entitlementRequests: 23000, remainingPercentage: 55.1, ...over } } });

describe('normalizeCredit', () => {
  it('maps premium_interactions → a status segment', () => {
    // 10327/23000 = 45% used (fraction + % both used-oriented); 55% remaining → normal severity.
    expect(normalizeCredit(snap())).toEqual({ text: 'premium: 10327/23000 (45%)', severity: 'normal' });
  });
  it('returns null for an unlimited entitlement', () => {
    expect(normalizeCredit(snap({ isUnlimitedEntitlement: true }))).toBeNull();
  });
  it('returns null when the snapshot / quota is missing', () => {
    expect(normalizeCredit({ quotaSnapshots: {} })).toBeNull();
    expect(normalizeCredit(undefined)).toBeNull();
  });
  it('escalates severity as remaining drops', () => {
    expect(normalizeCredit(snap({ remainingPercentage: 10 }))?.severity).toBe('warning');
    expect(normalizeCredit(snap({ remainingPercentage: 3 }))?.severity).toBe('critical');
  });
});

describe('refreshCopilotCredit — cache-aside (15-min TTL)', () => {
  const seg: StatusSegment = { text: 'premium: 1/2 (50%)', severity: 'normal' };
  beforeEach(() => __resetCreditCacheForTests());

  it('cache MISS → fetch, cache, send', async () => {
    const { client, store } = fakeCache();
    const sent: OutgoingMessage[] = [];
    const fetch = vi.fn(async () => seg);
    await refreshCopilotCredit(client, (m) => sent.push(m), 'app', () => 1000, fetch);
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.get('account-credit')).toEqual({ segment: seg, fetchedAt: 1000 });
    expect(sent).toEqual([{ type: 'status', credits: seg }]);  // no `state` → no streaming side effects
  });

  it('fresh cache HIT (<15min) → send cached, NO fetch', async () => {
    const { client } = fakeCache();
    client.put('account-credit', 'copilot', { segment: seg, fetchedAt: 1000 });
    const sent: OutgoingMessage[] = [];
    const fetch = vi.fn(async () => seg);
    await refreshCopilotCredit(client, (m) => sent.push(m), 'app', () => 1000 + 5 * 60_000, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'status', credits: seg }]);
  });

  it('STALE cache (>15min) → refetch', async () => {
    const { client } = fakeCache();
    client.put('account-credit', 'copilot', { segment: seg, fetchedAt: 1000 });
    const fetch = vi.fn(async () => seg);
    await refreshCopilotCredit(client, () => {}, 'app', () => 1000 + 16 * 60_000, fetch);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('null segment (unlimited) → caches the null but sends nothing', async () => {
    const { client, store } = fakeCache();
    const sent: OutgoingMessage[] = [];
    await refreshCopilotCredit(client, (m) => sent.push(m), 'app', () => 1000, async () => null);
    expect(store.get('account-credit')).toEqual({ segment: null, fetchedAt: 1000 });
    expect(sent).toEqual([]);
  });

  it('is fail-quiet when the fetch throws', async () => {
    const { client } = fakeCache();
    await expect(
      refreshCopilotCredit(client, () => {}, 'app', () => 1000, async () => { throw new Error('boom'); }),
    ).resolves.toBeUndefined();
  });

  it('without a dispatcher cache uses the process-local fallback (still TTL-throttled)', async () => {
    const sent: OutgoingMessage[] = [];
    const fetch = vi.fn(async () => seg);
    await refreshCopilotCredit(undefined, (m) => sent.push(m), 'app', () => 1000, fetch);          // miss → fetch
    await refreshCopilotCredit(undefined, (m) => sent.push(m), 'app', () => 1000 + 60_000, fetch); // 1 min → hit
    expect(fetch).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
  });
});
