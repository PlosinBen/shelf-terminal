import { describe, expect, it, vi } from 'vitest';
import type { Shell } from './connector';
import { encodeTerminalInitFrame, TERMINAL_INIT_PHASE, TERMINAL_INIT_RESULT } from '@shared/terminal-init-osc';
import {
  TERMINAL_SESSION_PHASE,
  TerminalInitSession,
  type TerminalSessionPhase,
} from './terminal-init-session';

function fakeShell(): Shell {
  return {
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

function explicitSession(options: { initScript?: string; tabCmd?: string } = {}) {
  const shell = fakeShell();
  const visible: string[] = [];
  const phases: TerminalSessionPhase[] = [];
  const failures: string[] = [];
  const session = new TerminalInitSession({
    shell,
    nonce: 'fixed_nonce',
    mode: 'explicit',
    initScript: options.initScript,
    tabCmd: options.tabCmd,
    onVisibleData: (data) => visible.push(data),
    onPhase: (phase) => phases.push(phase),
    onStartupFailure: (reason) => failures.push(reason),
  });
  return { shell, visible, phases, failures, session };
}

describe('TerminalInitSession', () => {
  it('suppresses hidden runner output and discards all user input until runner-ready', () => {
    const { shell, visible, phases, session } = explicitSession();
    session.start();

    session.handleData('hidden profile output');
    session.writeUser('typed too early\x03');

    expect(visible).toEqual([]);
    expect(shell.write).not.toHaveBeenCalled();
    expect(phases).toEqual([TERMINAL_SESSION_PHASE.runnerInitializing]);
  });

  it('opens visible initScript output after consuming the runner frame', () => {
    const { visible, phases, session } = explicitSession({ initScript: 'nvm use' });
    session.start();
    const ready = encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    });

    session.handleData(`hidden profile output${ready}init output`);

    expect(visible).toEqual(['init output']);
    expect(phases).toEqual([
      TERMINAL_SESSION_PHASE.runnerInitializing,
      TERMINAL_SESSION_PHASE.initScript,
    ]);
  });

  it('accepts only Ctrl-C while visible initScript is running', () => {
    const { shell, session } = explicitSession({ initScript: 'setup' });
    session.start();
    session.handleData(encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    }));
    vi.mocked(shell.write).mockClear();

    session.writeUser('abc\x03def\x03');

    expect(shell.write).toHaveBeenCalledOnce();
    expect(shell.write).toHaveBeenCalledWith('\x03\x03');
  });

  it('submits tabCmd atomically and becomes interactive after initScript success', () => {
    const { shell, phases, session } = explicitSession({ initScript: 'setup', tabCmd: 'npm run dev' });
    session.start();
    session.handleData(encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    }));
    vi.mocked(shell.write).mockClear();

    session.handleData(encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.initScript, result: TERMINAL_INIT_RESULT.success,
    }));

    expect(shell.write).toHaveBeenCalledOnce();
    expect(shell.write).toHaveBeenCalledWith('npm run dev\n');
    expect(phases.at(-1)).toBe(TERMINAL_SESSION_PHASE.ready);
    session.writeUser('user input');
    expect(shell.write).toHaveBeenLastCalledWith('user input');
  });

  it.each([
    TERMINAL_INIT_RESULT.failure,
    TERMINAL_INIT_RESULT.cancelled,
  ] as const)('skips tabCmd and opens interaction after initScript %s', (result) => {
    const { shell, phases, session } = explicitSession({ initScript: 'setup', tabCmd: 'must not run' });
    session.start();
    session.handleData(encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    }));
    vi.mocked(shell.write).mockClear();

    session.handleData(encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.initScript, result,
    }));

    expect(shell.write).not.toHaveBeenCalled();
    expect(phases.at(-1)).toBe(TERMINAL_SESSION_PHASE.ready);
  });

  it('uses one ordered write for Native automatic commands without completion claims', () => {
    const shell = fakeShell();
    const phases: TerminalSessionPhase[] = [];
    const session = new TerminalInitSession({
      shell,
      nonce: 'fixed_nonce',
      mode: 'native',
      initScript: 'setup',
      tabCmd: 'npm run dev',
      onVisibleData: () => {},
      onPhase: (phase) => phases.push(phase),
      onStartupFailure: () => {},
    });

    session.start();

    expect(shell.write).toHaveBeenCalledOnce();
    expect(shell.write).toHaveBeenCalledWith('setup\nnpm run dev\n');
    expect(phases).toEqual([
      TERMINAL_SESSION_PHASE.runnerInitializing,
      TERMINAL_SESSION_PHASE.ready,
    ]);
  });

  it('preserves a live no-frame shell and atomically enters fallback after 10 seconds', () => {
    vi.useFakeTimers();
    const { shell, visible, phases, session } = explicitSession({ initScript: 'setup', tabCmd: 'watch' });
    session.start();

    vi.advanceTimersByTime(10_000);

    expect(shell.write).toHaveBeenCalledOnce();
    expect(shell.write).toHaveBeenCalledWith(
      ': __SHELF_INIT_DIRECTIVE__ fixed_nonce fallback\nsetup\nwatch\n',
    );
    expect(phases.at(-1)).toBe(TERMINAL_SESSION_PHASE.ready);
    const delayed = encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    });
    session.handleData(delayed);
    expect(visible).toContain(delayed);
    vi.useRealTimers();
  });

  it('consumes stale or nonce-mismatched frames without advancing twice', () => {
    const anomalies: string[] = [];
    const shell = fakeShell();
    const session = new TerminalInitSession({
      shell,
      nonce: 'fixed_nonce',
      mode: 'explicit',
      initScript: 'setup',
      onVisibleData: () => {},
      onPhase: () => {},
      onStartupFailure: () => {},
      onProtocolAnomaly: (reason) => anomalies.push(reason),
    });
    session.start();
    session.handleData(encodeTerminalInitFrame({
      nonce: 'wrong_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    }));
    expect(session.currentPhase()).toBe(TERMINAL_SESSION_PHASE.runnerInitializing);

    const ready = encodeTerminalInitFrame({
      nonce: 'fixed_nonce', phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    });
    session.handleData(`${ready}${ready}`);

    expect(session.currentPhase()).toBe(TERMINAL_SESSION_PHASE.initScript);
    expect(shell.write).toHaveBeenCalledTimes(1);
    expect(anomalies).toEqual(['nonce-mismatch', 'unexpected-phase']);
  });

  it('replays bounded hidden output before reporting a real startup failure', () => {
    const { visible, failures, session } = explicitSession();
    session.start();
    session.handleData('useful shell diagnostic');

    session.failStartup('shell exited');

    expect(visible).toEqual(['useful shell diagnostic']);
    expect(failures).toEqual(['shell exited']);
  });

  it('discards all later input after disposal', () => {
    const { shell, session } = explicitSession();
    session.start();
    session.dispose();
    session.writeUser('ignored');
    expect(shell.write).not.toHaveBeenCalled();
  });
});
