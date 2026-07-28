import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import { codexEnv } from '../codex-shared/runtime';
import { spawnCodexAppServerRpc, type LoginRpc } from '../codex-shared/app-server-login';
import { serverLog } from '../../server-logger';
import type { ModelCacheClient, SendFn, StatusSegment } from '../types';

const ACCOUNT_STATUS_CACHE_KEY = 'account-status';
const ACCOUNT_STATUS_TTL_MS = 15 * 60 * 1000;

interface CachedAccountStatus {
  segments: CodexAccountStatusSegments | null;
  fetchedAt: number;
}

export interface CodexAccountStatusSegments {
  rateLimits: StatusSegment[];
  usage: StatusSegment | null;
}

export interface CodexAccountSnapshot {
  account: unknown;
  rateLimits: unknown;
  usage: unknown;
}

export type CodexAccountRpcFactory = (env: NodeJS.ProcessEnv) => { rpc: LoginRpc };

export async function fetchCodexAccountStatus(
  appId: string | undefined,
  spawnRpc: CodexAccountRpcFactory = (env) => spawnCodexAppServerRpc(env),
): Promise<CodexAccountSnapshot | null> {
  if (!appId) return null;
  const { rpc } = spawnRpc(codexEnv(appId));
  try {
    await rpc.request('initialize', {
      capabilities: null,
      clientInfo: { name: 'shelf', version: '0.0.0', title: 'Shelf' },
    });
    const [account, rateLimits, usage] = await Promise.all([
      rpc.request('account/read', { refreshToken: false }),
      rpc.request('account/rateLimits/read'),
      rpc.request('account/usage/read'),
    ]);
    return { account, rateLimits, usage };
  } finally {
    rpc.close();
  }
}

export function normalizeCodexAccountStatus(
  snapshot: CodexAccountSnapshot | null,
  now: () => number = Date.now,
): CodexAccountStatusSegments | null {
  if (!snapshot) return null;
  const rateLimits = normalizeRateLimitSegments(snapshot.rateLimits, now);
  // `account/usage/read` is account-level token activity, not session context
  // pressure. Keep it out of the status bar to avoid confusing it with `ctx%`.
  const usage = null;
  if (rateLimits.length === 0 && !usage) return null;
  return { rateLimits, usage };
}

export async function refreshCodexAccountStatus(
  cache: ModelCacheClient | undefined,
  send: SendFn,
  appId: string | undefined,
  now: () => number = Date.now,
  fetch: (appId: string | undefined) => Promise<CodexAccountStatusSegments | null> = async (a) => normalizeCodexAccountStatus(await fetchCodexAccountStatus(a), now),
): Promise<void> {
  try {
    const cached = cache
      ? ((await cache.get(ACCOUNT_STATUS_CACHE_KEY, CODEX_OFFICAL_PROVIDER)).value as CachedAccountStatus | undefined)
      : localAccountStatus;
    if (cached && now() - cached.fetchedAt < ACCOUNT_STATUS_TTL_MS) {
      emitCodexAccountStatus(send, cached.segments);
      return;
    }
    const segments = await fetch(appId);
    const entry: CachedAccountStatus = { segments, fetchedAt: now() };
    if (cache) cache.put(ACCOUNT_STATUS_CACHE_KEY, CODEX_OFFICAL_PROVIDER, entry);
    else localAccountStatus = entry;
    emitCodexAccountStatus(send, segments);
  } catch (err) {
    serverLog('warn', 'codex-account', `refresh failed: ${redactCodexAccountText((err as Error)?.message ?? String(err))}`);
  }
}

let localAccountStatus: CachedAccountStatus | undefined;

export function __resetCodexAccountStatusCacheForTests(): void {
  localAccountStatus = undefined;
}

function emitCodexAccountStatus(send: SendFn, segments: CodexAccountStatusSegments | null | undefined): void {
  if (!segments) return;
  const payload: Parameters<SendFn>[0] = {
    type: 'status',
    ...(segments.rateLimits.length > 0 ? { rateLimits: segments.rateLimits } : {}),
    ...(segments.usage ? { credits: segments.usage } : {}),
  };
  if (segments.rateLimits.length > 0 || segments.usage) send(payload);
}

function normalizeRateLimitSegments(raw: unknown, now: () => number): StatusSegment[] {
  const container = asRecord(raw);
  if (!container) return [];
  const byId = asRecord(container.rateLimitsByLimitId)
    ?? asRecord(container.rate_limits_by_limit_id)
    ?? asRecord(container.rateLimits)
    ?? asRecord(container.rate_limits);
  if (!byId) return [];

  return Object.entries(byId)
    .map(([id, bucket]) => normalizeRateLimitBucket(id, bucket, now))
    .filter((segment): segment is StatusSegment => !!segment);
}

function rateLimitUsedPercent(raw: unknown): number | null {
  const bucket = asRecord(raw);
  if (!bucket) return null;
  const primary = asRecord(bucket.primary) ?? bucket;
  return numberValue(primary.usedPercent ?? primary.used_percent);
}

function normalizeRateLimitBucket(id: string, raw: unknown, now: () => number): StatusSegment | null {
  const used = rateLimitUsedPercent(raw);
  if (used == null) return null;
  const bucket = asRecord(raw);
  const primary = asRecord(bucket?.primary) ?? bucket;
  if (!primary) return null;
  const reset = resetSuffix(primary.resetsAt ?? primary.resets_at, now);
  const usedRounded = Math.round(used);
  const label = rateLimitLabel(id, bucket);
  return {
    text: `${label}: ${usedRounded}%${reset ? ` ↻${reset}` : ''}`,
    severity: used >= 80 ? 'critical' : used >= 50 ? 'warning' : 'normal',
  };
}

function rateLimitLabel(id: string, bucket: Record<string, unknown> | null): string {
  if (id === 'codex') return '7d';
  const name = bucket?.limitName ?? bucket?.limit_name;
  return safeLabel(typeof name === 'string' && name.trim() ? name : id);
}

function resetSuffix(value: unknown, now: () => number): string | null {
  const ms = epochMs(value);
  if (ms == null) return null;
  const delta = ms - now();
  if (delta <= 0) return null;
  if (delta >= 86_400_000) return `${Math.round(delta / 86_400_000)}d`;
  if (delta >= 3_600_000) return `${(delta / 3_600_000).toFixed(1)}h`;
  return `${Math.ceil(delta / 60_000)}m`;
}

function epochMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = numberValue(value);
  if (n == null) return null;
  return n > 10_000_000_000 ? n : n * 1000;
}

function numberValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeLabel(value: string): string {
  return redactCodexAccountText(value).replace(/[^\w .:-]/g, '').slice(0, 48) || 'quota';
}

export function redactCodexAccountText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/\b(?:access|refresh|id)_token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, '<redacted-token>')
    .replace(/\b(?:account|org|organization|user|workspace)[_-]?id["'=:\s]+[A-Za-z0-9._:-]+/gi, '<redacted-id>');
}
