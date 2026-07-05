// The dispatcher's model/capability cache (dispatch-layering, group E). A GENERIC
// TTL store — TTL is intrinsic (a cache with no expiry is unreasonable: every
// entry must define "how old is too old"). Lives in the per-host dispatcher so the
// expensive Copilot `listModels` (~1.3s network) is fetched ONCE per host and
// shared across that host's exec procs via the cache-aside side-channel.
//
// FRESHNESS = TTL only. The intended account-guard (bust instantly on a re-login
// to a different account) is NOT implementable: the Copilot SDK's getAuthStatus
// exposes only { isAuthenticated, authType, host } — no per-account identity. So a
// same-host account switch is stale for at most TTL (a documented limitation; rare
// in practice — usually one account per host). Value is an OPAQUE blob the cache
// never inspects (each provider serializes its own model list).
export interface ModelCache {
  /** Cached value for `key`, or undefined if absent OR expired (expired → evicted). */
  get(key: string): unknown | undefined;
  put(key: string, value: unknown): void;
}

export function createModelCache(opts: { ttlMs: number; now?: () => number }): ModelCache {
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, { value: unknown; at: number }>();
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      if (now() - e.at >= opts.ttlMs) {
        store.delete(key); // expired
        return undefined;
      }
      return e.value;
    },
    put(key, value) {
      store.set(key, { value, at: now() });
    },
  };
}
