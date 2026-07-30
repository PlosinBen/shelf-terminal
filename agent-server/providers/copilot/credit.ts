// Copilot ACCOUNT-level credit/quota. `copilot --acp` never emits the ACP
// `usage_update` (upstream github/copilot-cli#4233), so we fetch the account
// premium-request quota out-of-band via the copilot SDK's `account.getQuota` and
// surface it as a status segment. Authenticated purely via config-home
// (`COPILOT_HOME` + `useLoggedInUser`) — NO token is read or passed, so the
// device-scoped-auth / provider boundary is preserved (Shelf only hands a PATH).
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { COPILOT_PROVIDER } from '@shared/agent-providers';
import { resolveCopilotBinary, copilotEnv } from './helpers';
import { serverLog } from '../../server-logger';
import type { ModelCacheClient, SendFn, StatusSegment } from '../types';

const CREDIT_CACHE_KEY = 'account-credit';
const CREDIT_TTL_MS = 15 * 60 * 1000; // 15 min — credit drifts slowly; also caps the spawn rate.

interface CachedCredit { segment: StatusSegment | null; fetchedAt: number }

/**
 * Normalize copilot's `account.getQuota` result into a status segment, or null when
 * there is nothing useful to show (unlimited entitlement / missing snapshot). Pure.
 * Only `premium_interactions` is surfaced (chat/completions are unlimited-entitlement).
 */
export function normalizeCredit(quota: unknown): StatusSegment | null {
  const p = (quota as {
    quotaSnapshots?: Record<string, {
      isUnlimitedEntitlement?: boolean; usedRequests?: number; entitlementRequests?: number; remainingPercentage?: number;
    } | undefined>;
  } | undefined)?.quotaSnapshots?.premium_interactions;
  if (!p || p.isUnlimitedEntitlement) return null;
  const used = Math.round(Number(p.usedRequests ?? 0));
  const total = Math.round(Number(p.entitlementRequests ?? 0));
  const remainingPct = Number(p.remainingPercentage ?? 0);
  // Display is all USED-oriented so the fraction and the % agree (used/total + used%).
  // Severity still keys off REMAINING (fewer left = more urgent).
  const usedPct = total > 0 ? Math.round((used / total) * 100) : Math.round(100 - remainingPct);
  const severity: StatusSegment['severity'] = remainingPct <= 5 ? 'critical' : remainingPct <= 15 ? 'warning' : 'normal';
  return { text: `premium: ${used}/${total} (${usedPct}%)`, severity };
}

/**
 * Fetch the premium-request quota via the copilot SDK (`account.getQuota`),
 * authenticated via the app's config-home (`COPILOT_HOME` + `useLoggedInUser`, no
 * token). Returns a segment, or null (unlimited / no appId / no binary / error).
 * Fail-quiet. Spawns a TRANSIENT copilot process (SDK RPC ≠ the ACP session) and
 * stops it — so keep the caller TTL-gated (see refreshCopilotCredit).
 */
export async function fetchCopilotCredit(appId: string | undefined): Promise<StatusSegment | null> {
  const bin = resolveCopilotBinary();
  if (!bin || !appId) return null;
  let client: CopilotClient | undefined;
  try {
    client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: bin }),
      env: copilotEnv(appId) as Record<string, string | undefined>,
      useLoggedInUser: true,
    });
    await client.start();
    const quota = await client.rpc.account.getQuota({});
    return normalizeCredit(quota);
  } catch (err) {
    serverLog('warn', 'copilot-credit', `getQuota failed: ${(err as Error)?.message ?? err}`);
    return null;
  } finally {
    try { await client?.stop(); } catch { /* best-effort teardown */ }
  }
}

// Process-local fallback when there's no dispatcher cache (single-tier / no
// EXEC_SID): still TTL-throttled, just not shared across the host's sessions.
let localCredit: CachedCredit | undefined;

/** Reset the process-local fallback cache. Tests only. */
export function __resetCreditCacheForTests(): void { localCredit = undefined; }

/**
 * Post-turn cache-aside: send the cached credit segment when fresh (< TTL), else
 * fetch → cache → send. Prefers the per-host dispatcher `cache` (shared across the
 * host's sessions — one fetch serves all), else the process-local fallback. Sends a
 * `status` with ONLY `credits` and NO `state` (a pure usage update — no turn-end
 * side effects). Fail-quiet. `now`/`fetch` injectable for tests.
 */
export async function refreshCopilotCredit(
  cache: ModelCacheClient | undefined,
  send: SendFn,
  appId: string | undefined,
  now: () => number = Date.now,
  fetch: (a: string | undefined) => Promise<StatusSegment | null> = fetchCopilotCredit,
): Promise<void> {
  try {
    const cached = cache
      ? ((await cache.get(CREDIT_CACHE_KEY, COPILOT_PROVIDER)).value as CachedCredit | undefined)
      : localCredit;
    if (cached && now() - cached.fetchedAt < CREDIT_TTL_MS) {
      if (cached.segment) send({ type: 'status', credits: cached.segment });
      return;
    }
    const segment = await fetch(appId);
    const entry: CachedCredit = { segment, fetchedAt: now() };
    if (cache) cache.put(CREDIT_CACHE_KEY, COPILOT_PROVIDER, entry);
    else localCredit = entry;
    if (segment) send({ type: 'status', credits: segment });
  } catch (err) {
    serverLog('warn', 'copilot-credit', `refresh failed: ${(err as Error)?.message ?? err}`);
  }
}
