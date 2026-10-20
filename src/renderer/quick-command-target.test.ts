import { describe, expect, it } from 'vitest';
import { resolveQuickCommandTarget } from './quick-command-target';

const tabs = [
  { id: 'terminal-1', label: 'Shell', type: 'terminal' as const },
  { id: 'agent-1', label: 'Claude', type: 'agent' as const },
  { id: 'web-1', label: 'Docs', type: 'web' as const },
];

describe('resolveQuickCommandTarget', () => {
  it('resolves the current Terminal tab', () => {
    expect(resolveQuickCommandTarget({ tabs, activeTabIndex: 0 }, 'current')).toEqual({
      ok: true,
      tabId: 'terminal-1',
    });
  });

  it('resolves a named Terminal tab', () => {
    expect(resolveQuickCommandTarget({ tabs, activeTabIndex: 1 }, 'Shell')).toEqual({
      ok: true,
      tabId: 'terminal-1',
    });
  });

  it.each([
    ['current Agent', 1, 'current', 'Current tab "Claude" is an Agent tab, not a Terminal.'],
    ['current Web', 2, 'current', 'Current tab "Docs" is a Web tab, not a Terminal.'],
    ['named Agent', 0, 'Claude', 'Quick Command target "Claude" is an Agent tab, not a Terminal.'],
    ['named Web', 0, 'Docs', 'Quick Command target "Docs" is a Web tab, not a Terminal.'],
  ])('refuses a %s target', (_case, activeTabIndex, target, message) => {
    expect(resolveQuickCommandTarget({ tabs, activeTabIndex }, target)).toEqual({
      ok: false,
      reason: 'non-terminal',
      message,
    });
  });

  it('refuses a missing current tab', () => {
    expect(resolveQuickCommandTarget({ tabs: [], activeTabIndex: 0 }, 'current')).toEqual({
      ok: false,
      reason: 'missing',
      message: 'No current tab is available for this Quick Command.',
    });
  });

  it('refuses a stale named target', () => {
    expect(resolveQuickCommandTarget({ tabs, activeTabIndex: 0 }, 'Removed')).toEqual({
      ok: false,
      reason: 'missing',
      message: 'Quick Command target "Removed" is not open.',
    });
  });
});
