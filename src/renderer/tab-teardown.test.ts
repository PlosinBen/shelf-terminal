import { describe, it, expect, vi, beforeEach } from 'vitest';

// TerminalView pulls in xterm; the teardown module only needs disposeTerminal,
// so mock it (also keeps this node-env test from loading the DOM-heavy module).
vi.mock('./components/TerminalView', () => ({ disposeTerminal: vi.fn() }));

import { teardownTab } from './tab-teardown';
import { disposeTerminal } from './components/TerminalView';

const destroy = vi.fn();
const kill = vi.fn();

beforeEach(() => {
  destroy.mockClear();
  kill.mockClear();
  (disposeTerminal as unknown as ReturnType<typeof vi.fn>).mockClear();
  (globalThis as unknown as { window: unknown }).window = {
    shelfApi: { agent: { destroy }, pty: { kill } },
  };
});

describe('teardownTab', () => {
  // Regression: DISCONNECT_PROJECT forgot the agent branch, leaking the
  // agent-server exec (+ provider CLI). Every path now routes through this fn.
  it('agent tab → destroys the agent backend (and touches nothing else)', () => {
    teardownTab({ id: 'a1', type: 'agent' });
    expect(destroy).toHaveBeenCalledWith('a1');
    expect(kill).not.toHaveBeenCalled();
    expect(disposeTerminal).not.toHaveBeenCalled();
  });

  it('terminal tab → kills the PTY + disposes the xterm instance', () => {
    teardownTab({ id: 't1', type: 'terminal' });
    expect(kill).toHaveBeenCalledWith('t1');
    expect(disposeTerminal).toHaveBeenCalledWith('t1');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('web tab → no teardown (webview unmounts itself)', () => {
    teardownTab({ id: 'w1', type: 'web' });
    expect(destroy).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(disposeTerminal).not.toHaveBeenCalled();
  });
});
