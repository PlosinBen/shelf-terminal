import type { ProviderModel } from '@shared/types';

/** Dynamic model-list fetch status for providers with `dynamicModelList`. */
export type ListStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';
export type ListError = 'unreachable' | 'timeout' | 'parse_error' | null;

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Merge detected + custom models, deduped by id. Custom overrides detected
 *  for the same id (lets user enrich auto-discovered entries with
 *  contextWindow / reasoning flag). */
export function mergeModelLists(detected: ProviderModel[], custom: ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const m of detected) byId.set(m.id, m);
  for (const m of custom) byId.set(m.id, m); // custom wins
  return Array.from(byId.values());
}
