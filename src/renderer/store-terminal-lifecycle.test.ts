import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTerminalLifecycle,
  getTerminalLifecycleSliceSnapshot,
  initializeTerminalLifecycle,
  resetTerminalLifecycleStoreForTests,
  setTerminalInitPhase,
} from './store-terminal-lifecycle';

describe('terminal lifecycle store', () => {
  beforeEach(resetTerminalLifecycleStoreForTests);

  it('owns initialization phase by tab and clears it on disposal', () => {
    initializeTerminalLifecycle('tab-1');
    setTerminalInitPhase('tab-1', 'init-script');
    setTerminalInitPhase('tab-2', 'ready');

    expect(getTerminalLifecycleSliceSnapshot().terminalInitPhases).toEqual({
      'tab-1': 'init-script',
      'tab-2': 'ready',
    });

    clearTerminalLifecycle('tab-1');
    expect(getTerminalLifecycleSliceSnapshot().terminalInitPhases).toEqual({ 'tab-2': 'ready' });
  });
});
