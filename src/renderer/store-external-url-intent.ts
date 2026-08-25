import type { ExternalUrlIntentRequest } from '@shared/external-url-intent';
import { emitStoreChange } from './store-core';

export interface ExternalUrlIntentUiItem extends ExternalUrlIntentRequest {
  sourceLabel: string;
  resolving: boolean;
  error: string | null;
}

export interface ExternalUrlIntentSliceSnapshot {
  externalUrlIntents: readonly ExternalUrlIntentUiItem[];
}

let externalUrlIntents: ExternalUrlIntentUiItem[] = [];

export function getExternalUrlIntentSliceSnapshot(): ExternalUrlIntentSliceSnapshot {
  return { externalUrlIntents };
}

export function enqueueExternalUrlIntent(
  request: ExternalUrlIntentRequest & { sourceLabel: string },
): void {
  if (externalUrlIntents.some((item) => item.requestId === request.requestId)) {
    console.warn(`[external-url-intent] duplicate request ${request.requestId}`);
    return;
  }
  externalUrlIntents = [...externalUrlIntents, { ...request, resolving: false, error: null }];
  emitStoreChange();
}

export function beginExternalUrlIntentResolution(requestId: string): boolean {
  const current = externalUrlIntents[0];
  if (!current || current.requestId !== requestId || current.resolving) return false;
  externalUrlIntents = [
    { ...current, resolving: true, error: null },
    ...externalUrlIntents.slice(1),
  ];
  emitStoreChange();
  return true;
}

export function setExternalUrlIntentError(requestId: string, error: string): void {
  const index = externalUrlIntents.findIndex((item) => item.requestId === requestId);
  if (index === -1) {
    console.warn(`[external-url-intent] error for unknown request ${requestId}`);
    return;
  }
  externalUrlIntents = externalUrlIntents.map((item, itemIndex) => (
    itemIndex === index ? { ...item, resolving: false, error } : item
  ));
  emitStoreChange();
}

export function removeExternalUrlIntent(requestId: string): void {
  const next = externalUrlIntents.filter((item) => item.requestId !== requestId);
  if (next.length === externalUrlIntents.length) return;
  externalUrlIntents = next;
  emitStoreChange();
}

export function resetExternalUrlIntentStoreForTests(): void {
  externalUrlIntents = [];
  emitStoreChange();
}
