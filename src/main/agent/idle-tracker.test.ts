import { describe, it, expect, vi } from 'vitest';
import { createIdleTracker } from './idle-tracker';

// A controllable fake timer: records scheduled callbacks by handle so a test
// can fire them deterministically without wall-clock waits.
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  return {
    setTimer: (cb: () => void, ms: number) => { const h = ++seq; pending.set(h, { cb, ms }); return h as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (h: ReturnType<typeof setTimeout>) => { pending.delete(h as unknown as number); },
    fire: (h: number) => { const e = pending.get(h); if (e) { pending.delete(h); e.cb(); } },
    fireAll: () => { for (const [h, e] of [...pending]) { pending.delete(h); e.cb(); } },
    size: () => pending.size,
    lastMs: () => [...pending.values()].at(-1)?.ms,
  };
}

describe('createIdleTracker', () => {
  it('arms a timer and fires onIdle after the timeout', () => {
    const t = fakeTimers();
    const onIdle = vi.fn();
    const tr = createIdleTracker({ onIdle, setTimer: t.setTimer, clearTimer: t.clearTimer, timeoutMinutes: 5 });
    tr.arm('a');
    expect(t.lastMs()).toBe(5 * 60_000);
    t.fireAll();
    expect(onIdle).toHaveBeenCalledWith('a');
  });

  it('touch cancels a pending fire (activity keeps the tab alive)', () => {
    const t = fakeTimers();
    const onIdle = vi.fn();
    const tr = createIdleTracker({ onIdle, setTimer: t.setTimer, clearTimer: t.clearTimer, timeoutMinutes: 5 });
    tr.arm('a');
    tr.touch('a');
    expect(t.size()).toBe(0);
    t.fireAll();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('timeout 0 disables — arm is a no-op', () => {
    const t = fakeTimers();
    const onIdle = vi.fn();
    const tr = createIdleTracker({ onIdle, setTimer: t.setTimer, clearTimer: t.clearTimer, timeoutMinutes: 0 });
    tr.arm('a');
    expect(t.size()).toBe(0);
    t.fireAll();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('re-arm replaces the prior timer (no double-fire)', () => {
    const t = fakeTimers();
    const onIdle = vi.fn();
    const tr = createIdleTracker({ onIdle, setTimer: t.setTimer, clearTimer: t.clearTimer, timeoutMinutes: 5 });
    tr.arm('a');
    tr.arm('a');
    expect(t.size()).toBe(1);
    t.fireAll();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('setTimeoutMinutes affects future arms; forget/dispose cancel', () => {
    const t = fakeTimers();
    const onIdle = vi.fn();
    const tr = createIdleTracker({ onIdle, setTimer: t.setTimer, clearTimer: t.clearTimer, timeoutMinutes: 5 });
    tr.setTimeoutMinutes(2);
    tr.arm('a');
    expect(t.lastMs()).toBe(2 * 60_000);
    tr.forget('a');
    expect(t.size()).toBe(0);
    tr.arm('b'); tr.arm('c');
    tr.dispose();
    expect(t.size()).toBe(0);
  });
});
