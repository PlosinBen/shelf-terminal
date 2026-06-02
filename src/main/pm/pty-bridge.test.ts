import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handlePtyData, handlePtyRemove, handlePtyClear } from './pty-bridge';
import * as scrollback from './scrollback-buffer';
import * as watcher from './tab-watcher';

// These PM-side handlers are what index.ts injects into pty-manager via
// setPtyObserver(). The risk this guards: a botched inversion silently stops
// feeding scrollback / tab-watcher (no error, just dead PM features).
describe('pty-bridge handlers', () => {
  beforeEach(() => {
    scrollback.clear();
  });
  afterEach(() => {
    scrollback.clear();
    vi.restoreAllMocks();
  });

  it('handlePtyData appends output to scrollback', () => {
    handlePtyData('t1', 'hello\n');
    expect(scrollback.has('t1')).toBe(true);
    expect(scrollback.read('t1')).toContain('hello');
  });

  it('handlePtyData accumulates successive chunks', () => {
    handlePtyData('t1', 'a');
    handlePtyData('t1', 'b');
    expect(scrollback.read('t1')).toBe('ab');
  });

  it('handlePtyData appends BEFORE re-checking tab state (ordering contract)', () => {
    // tab-watcher reads scrollback, so append must have run by the time
    // checkTab fires — assert that from inside the checkTab spy.
    const spy = vi.spyOn(watcher, 'checkTab').mockImplementation((tabId: string) => {
      expect(scrollback.has(tabId)).toBe(true);
    });
    handlePtyData('t2', 'x');
    expect(spy).toHaveBeenCalledWith('t2');
  });

  it('handlePtyRemove drops only the target tab', () => {
    const removeSpy = vi.spyOn(watcher, 'removeTab');
    handlePtyData('t1', 'one');
    handlePtyData('t2', 'two');
    handlePtyRemove('t1');
    expect(scrollback.has('t1')).toBe(false);
    expect(scrollback.has('t2')).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith('t1');
  });

  it('handlePtyClear wipes all tabs', () => {
    const clearSpy = vi.spyOn(watcher, 'clearAll');
    handlePtyData('t1', 'one');
    handlePtyData('t2', 'two');
    handlePtyClear();
    expect(scrollback.allTabIds()).toEqual([]);
    expect(clearSpy).toHaveBeenCalled();
  });
});
