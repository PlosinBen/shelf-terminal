import { describe, it, expect } from 'vitest';
import { shouldFetchOutput, decideTaskButton } from './BackgroundTasksPanel';
import type { NormalizedTask } from '../../../shared/types';

/**
 * Pure-logic test for the "fetch / refetch a settled task's output" gate
 * (component rendering/clicks deferred to E2E, per the picker convention).
 */
describe('shouldFetchOutput', () => {
  const task = (over: Partial<NormalizedTask> = {}): NormalizedTask =>
    ({ id: 't1', type: 'shell', label: 'cmd', status: 'completed', done: true, ...over });

  // Regression: expanded WHILE running (no fetch), then settled → must fetch.
  // Previously this case rendered "(empty output)" forever despite real output.
  it('is true for a settled, expanded task never fetched', () => {
    expect(shouldFetchOutput(task(), { loading: false }, undefined)).toBe(true);
  });

  // Regression (the empty-card bug): the trailing notification replaces the task
  // object with a NEW version carrying the output_file. Even though a (placeholder)
  // fetch already ran, the new identity must trigger a refetch so the card fills in.
  it('is true when a newer task version arrives after a prior fetch', () => {
    const fetched = task();
    const newer = task({ summary: 'done' }); // fresh object from applyTaskEvent
    expect(shouldFetchOutput(newer, { loading: false, content: '(no output recorded for this task)' }, fetched)).toBe(true);
  });

  it('is false once THIS version was fetched (no loop on a stable task)', () => {
    const t = task();
    expect(shouldFetchOutput(t, { loading: false, content: 'output' }, t)).toBe(false);
    expect(shouldFetchOutput(t, { loading: false, content: '' }, t)).toBe(false);
  });

  it('is false while a fetch is in flight', () => {
    expect(shouldFetchOutput(task(), { loading: true }, undefined)).toBe(false);
  });

  it('is false before the task settles', () => {
    expect(shouldFetchOutput(task({ done: false, status: 'running' }), { loading: false }, undefined)).toBe(false);
  });

  it('is false when the task is not expanded', () => {
    expect(shouldFetchOutput(task(), undefined, undefined)).toBe(false);
  });
});

describe('decideTaskButton', () => {
  it('settled task → plain dismiss (×)', () => {
    expect(decideTaskButton(true, false, false)).toBe('dismiss');
  });

  it('running task → Stop (idle) until armed, then Stop? (armed)', () => {
    expect(decideTaskButton(false, false, false)).toBe('stop-idle');
    expect(decideTaskButton(false, false, true)).toBe('stop-armed');
  });

  it('stopping wins over everything (running or done)', () => {
    expect(decideTaskButton(false, true, true)).toBe('stopping');
    expect(decideTaskButton(true, true, false)).toBe('stopping');
  });

  it('a settled task never shows a stop affordance, even if armed flag lingers', () => {
    expect(decideTaskButton(true, false, true)).toBe('dismiss');
  });
});
