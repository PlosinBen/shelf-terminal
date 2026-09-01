import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Idle-notification logic (terminal-pty#4) is the risky bit in pty-manager:
// a "Command finished" notification fires only when ALL hold —
//   active for >= 5s (MIN_ACTIVE_MS), the user typed something this window
//   (userInput), the tab isn't muted, and the window is alive but unfocused.
// We drive a fake shell's onData with fake timers to exercise the gate.

const h = vi.hoisted(() => {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(code: number) => void> = [];
  const kill = vi.fn();
  const write = vi.fn();
  const createShell = () => ({
    onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} }; },
    onExit: (cb: (code: number) => void) => { exitCbs.push(cb); return { dispose: () => {} }; },
    write,
    resize: () => {},
    kill,
  });
  let targetFactsResult: any = { ok: false, reason: 'probe-failed', attempts: [] };
  let spawnCount = 0;
  const show = vi.fn();
  const Notification = vi.fn(function () { return { show }; });
  return {
    dataCbs, exitCbs, kill, write, createShell, show, Notification,
    get targetFactsResult() { return targetFactsResult; },
    set targetFactsResult(value: any) { targetFactsResult = value; },
    get spawnCount() { return spawnCount; },
    incrementSpawn() { spawnCount++; },
    resetSpawn() { spawnCount = 0; },
  };
});

vi.mock('electron', () => ({ Notification: h.Notification, BrowserWindow: class {} }));
vi.mock('./connector', () => ({
  createConnector: () => ({
    generation: { id: 'test-generation' },
    createCompatibilityLaunchPlan: () => ({
      kind: 'compatibility', executable: 'test', args: [], cwd: '/cwd', env: {}, logContext: 'test',
    }),
    createInterpreterLaunchPlan: () => ({
      kind: 'interpreter', executable: '/bin/zsh', args: ['-l'], cwd: '/cwd', env: {}, logContext: 'test',
    }),
    spawnTerminalPlan: () => { h.incrementSpawn(); return h.createShell(); },
  }),
}));
vi.mock('./connector/target-facts', () => ({
  TargetFactsResolver: class {
    resolve() {
      return Promise.resolve(h.targetFactsResult);
    }
  },
}));
vi.mock('./terminal-runner/runners', () => ({
  prepareRunnerLaunch: async (context: any) => ({
    plan: 'compatibilityPlan' in context.selection
      ? context.selection.compatibilityPlan
      : { kind: 'interpreter', executable: context.selection.interpreter, args: ['-l'], cwd: context.cwd, env: {}, logContext: 'test' },
    mode: context.selection.kind === 'zsh' ? 'explicit' : 'native',
    directiveMode: context.selection.kind === 'zsh' ? 'shell' : 'none',
    historyIsolation: context.selection.kind === 'zsh' ? 'attempted' : 'native',
  }),
}));
vi.mock('./app-instance-id', () => ({ getAppInstanceId: () => 'test-app' }));
vi.mock('./file-transfer', () => ({ maybeScheduleCleanup: () => {} }));

import { spawnPty, writePty, setMuted, setPtyObserver, teardownProjectPtys } from './pty-manager';
import { encodeExternalUrlOscFrame, EXTERNAL_URL_OSC_PREFIX } from '@shared/external-url-osc';

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
  h.exitCbs.length = 0;
  h.kill.mockClear();
  h.write.mockClear();
  h.resetSpawn();
  h.targetFactsResult = { ok: false, reason: 'probe-failed', attempts: [] };
  h.show.mockClear();
  h.Notification.mockClear();
  setPtyObserver({});
});

describe('pty-manager project teardown', () => {
  it('waits for PTY exit acknowledgement before confirming project teardown', async () => {
    await spawnPty('project-teardown', 'tab-teardown', '/cwd', conn, makeWin(false));

    const teardown = teardownProjectPtys('project-teardown', 1000);
    expect(h.kill).toHaveBeenCalledOnce();
    h.exitCbs.forEach((callback) => callback(0));

    await expect(teardown).resolves.toEqual({ confirmed: true, unconfirmedTabIds: [] });
  });

  it('reports an unconfirmed tab when the bounded exit acknowledgement expires', async () => {
    await spawnPty('project-timeout', 'tab-timeout', '/cwd', conn, makeWin(false));

    const teardown = teardownProjectPtys('project-timeout', 1000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(teardown).resolves.toEqual({
      confirmed: false,
      unconfirmedTabIds: ['tab-timeout'],
    });
  });
});

describe('pty-manager runner degradation', () => {
  it('retries the same resolved shell once without isolation only after enhanced launch exits', async () => {
    h.targetFactsResult = {
      ok: true,
      facts: { targetOS: 'unix', defaultShell: '/bin/zsh' },
    };
    const win = makeWin(false);
    await spawnPty('project-retry', 'tab-retry', '/cwd', conn, win, 'setup', 'tab command');
    expect(h.spawnCount).toBe(1);

    h.exitCbs[0](1);

    expect(h.spawnCount).toBe(2);
    expect(h.write).toHaveBeenCalledWith('setup\ntab command\n');
    expect(win.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything());
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pty-manager idle notification (terminal-pty#4)', () => {
  it('notifies after sustained activity when user typed and window is unfocused', async () => {
    await spawnPty('p', 'tab-ok', '/cwd', conn, makeWin(false));
    emit('seed');                 // create activity state
    writePty('tab-ok', 'ls\n');   // userInput = true
    await sustainThenIdle();
    expect(h.show).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify when the user never typed (no userInput)', async () => {
    await spawnPty('p', 'tab-noinput', '/cwd', conn, makeWin(false));
    await sustainThenIdle();      // output only, no writePty
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does NOT notify when the tab is muted', async () => {
    await spawnPty('p', 'tab-muted', '/cwd', conn, makeWin(false));
    setMuted('tab-muted', true);
    emit('seed');
    writePty('tab-muted', 'ls\n');
    await sustainThenIdle();
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does NOT notify when the window is focused', async () => {
    await spawnPty('p', 'tab-focused', '/cwd', conn, makeWin(true));
    emit('seed');
    writePty('tab-focused', 'ls\n');
    await sustainThenIdle();
    expect(h.show).not.toHaveBeenCalled();
  });

  it('does NOT notify when active for less than 5s', async () => {
    await spawnPty('p', 'tab-short', '/cwd', conn, makeWin(false));
    emit('seed');
    writePty('tab-short', 'ls\n');
    await vi.advanceTimersByTimeAsync(3000); // idle fires after ~0s of activity
    expect(h.show).not.toHaveBeenCalled();
  });
});

describe('pty-manager external URL frames', () => {
  it('strips a frame from observer/renderer output and preserves PTY source identity', async () => {
    const onData = vi.fn();
    const onExternalUrl = vi.fn();
    const onProtocolAnomaly = vi.fn();
    const win = makeWin(false);
    setPtyObserver({ onData, onExternalUrl, onProtocolAnomaly });
    await spawnPty('project-1', 'tab-1', '/cwd', conn, win);
    const url = 'https://terminal.example/oauth?state=exact-private';

    emit(`before${encodeExternalUrlOscFrame(url)}after`);

    expect(onExternalUrl).toHaveBeenCalledWith('project-1', 'tab-1', url);
    expect(onData).toHaveBeenCalledWith('tab-1', 'beforeafter');
    expect(onProtocolAnomaly).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('pty:data', {
      tabId: 'tab-1',
      data: 'beforeafter',
    });
    expect(JSON.stringify(win.webContents.send.mock.calls)).not.toContain(EXTERNAL_URL_OSC_PREFIX);
  });

  it('strips malformed frames and reports a bounded anomaly without payload data', async () => {
    const onData = vi.fn();
    const onExternalUrl = vi.fn();
    const onProtocolAnomaly = vi.fn();
    const win = makeWin(false);
    setPtyObserver({ onData, onExternalUrl, onProtocolAnomaly });
    await spawnPty('project-1', 'tab-1', '/cwd', conn, win);

    emit(`left${EXTERNAL_URL_OSC_PREFIX}private+payload\x07right`);

    expect(onExternalUrl).not.toHaveBeenCalled();
    expect(onProtocolAnomaly).toHaveBeenCalledWith('project-1', 'tab-1', 'invalid-payload');
    expect(onData).toHaveBeenCalledWith('tab-1', 'leftright');
    expect(JSON.stringify(onProtocolAnomaly.mock.calls)).not.toContain('private+payload');
  });
});
