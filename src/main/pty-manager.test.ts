import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Idle-notification logic (GOTCHAS #7) is the risky bit in pty-manager:
// a "Command finished" notification fires only when ALL hold —
//   active for >= 5s (MIN_ACTIVE_MS), the user typed something this window
//   (userInput), the tab isn't muted, and the window is alive but unfocused.
// We drive a fake shell's onData with fake timers to exercise the gate.

const h = vi.hoisted(() => {
  const dataCbs: Array<(d: string) => void> = [];
  const shell = {
    onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} }; },
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
  const show = vi.fn();
  const Notification = vi.fn(function () { return { show }; });
  return { dataCbs, shell, show, Notification };
});

vi.mock('electron', () => ({ Notification: h.Notification, BrowserWindow: class {} }));
vi.mock('./connector', () => ({ createConnector: () => ({ createShell: () => h.shell }) }));
vi.mock('./file-transfer', () => ({ maybeScheduleCleanup: () => {} }));

import { spawnPty, writePty, setMuted } from './pty-manager';

const conn = {} as any;
function makeWin(focused = false) {
  return { isDestroyed: () => false, isFocused: () => focused, webContents: { send: vi.fn() } } as any;
}
const emit = (d: string) => h.dataCbs.forEach((cb) => cb(d));

/** Drive >5s of sustained output (chunks every 2s so the 3s idle timer keeps
 *  resetting and firstDataTime stays put), then 3s of silence to fire idle. */
async function sustainThenIdle() {
  emit('a');
  await vi.advanceTimersByTimeAsync(2000); emit('b');
  await vi.advanceTimersByTimeAsync(2000); emit('c');
  await vi.advanceTimersByTimeAsync(2000); emit('d'); // ~6s of activity
  await vi.advanceTimersByTimeAsync(3000);            // idle threshold elapses
}

beforeEach(() => {
  vi.useFakeTimers();
  h.dataCbs.length = 0;
  h.show.mockClear();
  h.Notification.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pty-manager idle notification (GOTCHAS #7)', () => {
  it('notifies after sustained activity when user typed and window is unfocused', async () => {
    spawnPty('p', 'tab-ok', '/cwd', conn, makeWin(false));
    emit('seed');                 // create activity state
    writePty('tab-ok', 'ls\n');   // userInput = true
    await sustainThenIdle();
    expect(h.show).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify when the user never typed (no userInput)', async () => {
    spawnPty('p', 'tab-noinput', '/cwd', conn, makeWin(false));
    await sustainThenIdle();      // output only, no writePty
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does NOT notify when the tab is muted', async () => {
    spawnPty('p', 'tab-muted', '/cwd', conn, makeWin(false));
    setMuted('tab-muted', true);
    emit('seed');
    writePty('tab-muted', 'ls\n');
    await sustainThenIdle();
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does NOT notify when the window is focused', async () => {
    spawnPty('p', 'tab-focused', '/cwd', conn, makeWin(true));
    emit('seed');
    writePty('tab-focused', 'ls\n');
    await sustainThenIdle();
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does NOT notify when active for less than 5s', async () => {
    spawnPty('p', 'tab-short', '/cwd', conn, makeWin(false));
    emit('seed');
    writePty('tab-short', 'ls\n');
    await vi.advanceTimersByTimeAsync(3000); // idle fires after ~0s of activity
    expect(h.show).not.toHaveBeenCalled();
  });
});
