import { describe, it, expect } from 'vitest';
import { needsOutputFetch } from './BackgroundTasksPanel';

/**
 * Pure-logic test for the "fetch output after a running task settles" gate
 * (component rendering/clicks deferred to E2E, per the picker convention).
 */
describe('needsOutputFetch', () => {
  // Regression: expanded WHILE running (no fetch), then settled → must fetch.
  // Previously this case rendered "(empty output)" forever despite real output.
  it('is true for a settled, expanded task that never fetched', () => {
    expect(needsOutputFetch(true, { loading: false })).toBe(true);
  });

  it('is false while a fetch is in flight', () => {
    expect(needsOutputFetch(true, { loading: true })).toBe(false);
  });

  it('is false once fetched — including a genuinely empty result', () => {
    expect(needsOutputFetch(true, { loading: false, content: 'output' })).toBe(false);
    expect(needsOutputFetch(true, { loading: false, content: '' })).toBe(false); // fetched-empty ≠ never-fetched
  });

  it('is false when the prior fetch errored', () => {
    expect(needsOutputFetch(true, { loading: false, error: 'boom' })).toBe(false);
  });

  it('is false before the task settles', () => {
    expect(needsOutputFetch(false, { loading: false })).toBe(false);
  });

  it('is false when the task is not expanded', () => {
    expect(needsOutputFetch(true, undefined)).toBe(false);
  });
});
