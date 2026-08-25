import { beforeEach, describe, expect, it } from 'vitest';
import type { ExternalUrlIntentRequest } from '@shared/external-url-intent';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  beginExternalUrlIntentResolution,
  enqueueExternalUrlIntent,
  removeExternalUrlIntent,
  setExternalUrlIntentError,
} from './store';

const request = (requestId: string): ExternalUrlIntentRequest => ({
  requestId,
  url: `https://example.com/oauth?id=${requestId}`,
  reason: 'Sign in',
  source: { kind: 'app-window' },
  destination: { kind: 'web-origin', origin: 'https://example.com' },
});

describe('external URL intent store', () => {
  beforeEach(() => __resetStoreForTests());

  it('queues request snapshots in arrival order', () => {
    enqueueExternalUrlIntent({ ...request('one'), sourceLabel: 'Shelf app window' });
    enqueueExternalUrlIntent({ ...request('two'), sourceLabel: 'Shelf app window' });

    expect(__getSnapshotForTests().externalUrlIntents.map((item) => item.requestId)).toEqual(['one', 'two']);
  });

  it('allows one in-flight decision and keeps failures visible', () => {
    enqueueExternalUrlIntent({ ...request('one'), sourceLabel: 'Shelf app window' });

    expect(beginExternalUrlIntentResolution('one')).toBe(true);
    expect(beginExternalUrlIntentResolution('one')).toBe(false);
    setExternalUrlIntentError('one', 'Clipboard is unavailable');

    expect(__getSnapshotForTests().externalUrlIntents[0]).toMatchObject({
      requestId: 'one',
      resolving: false,
      error: 'Clipboard is unavailable',
    });
  });

  it('removes only the request closed by main', () => {
    enqueueExternalUrlIntent({ ...request('one'), sourceLabel: 'Shelf app window' });
    enqueueExternalUrlIntent({ ...request('two'), sourceLabel: 'Shelf app window' });

    removeExternalUrlIntent('two');

    expect(__getSnapshotForTests().externalUrlIntents.map((item) => item.requestId)).toEqual(['one']);
  });
});
