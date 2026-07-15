// Per-key idle tracker (pure, injectable timers → unit-testable).
//
// Drives agent-tab idle-teardown: `touch` on activity cancels a pending fire;
// `arm` when a tab goes idle schedules `onIdle(key)` after the configured
// timeout. `0` minutes disables it entirely (opt-in). See claude-idle-teardown.

type TimerHandle = ReturnType<typeof setTimeout>;

export interface IdleTrackerDeps {
  /** Called when `key` has stayed idle for the full timeout. */
  onIdle: (key: string) => void;
  /** Injectable for tests; defaults to setTimeout/clearTimeout. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  /** Initial timeout in minutes (0 = disabled). */
  timeoutMinutes?: number;
}

export interface IdleTracker {
  /** Update the timeout (minutes; 0 disables). Applies to future `arm`s. */
  setTimeoutMinutes(min: number): void;
  /** Activity on `key` — cancel any pending idle fire. */
  touch(key: string): void;
  /** `key` went idle — schedule `onIdle(key)` after the timeout (no-op if disabled). */
  arm(key: string): void;
  /** Stop tracking `key` (cancels any pending fire). */
  forget(key: string): void;
  /** Cancel everything. */
  dispose(): void;
}

export function createIdleTracker(deps: IdleTrackerDeps): IdleTracker {
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const timers = new Map<string, TimerHandle>();
  let timeoutMin = Math.max(0, deps.timeoutMinutes ?? 0);

  function cancel(key: string): void {
    const h = timers.get(key);
    if (h !== undefined) {
      clearTimer(h);
      timers.delete(key);
    }
  }

  return {
    setTimeoutMinutes(min: number) {
      timeoutMin = Math.max(0, min || 0);
    },
    touch(key: string) {
      cancel(key);
    },
    arm(key: string) {
      cancel(key);
      if (timeoutMin <= 0) return; // disabled
      const ms = timeoutMin * 60_000;
      timers.set(key, setTimer(() => {
        timers.delete(key);
        deps.onIdle(key);
      }, ms));
    },
    forget(key: string) {
      cancel(key);
    },
    dispose() {
      for (const h of timers.values()) clearTimer(h);
      timers.clear();
    },
  };
}
