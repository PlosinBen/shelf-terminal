/**
 * Regression tests for escapeTelegramMarkdown — guards against the bug where
 * the control announcement's `/use_<alias>` lines made Telegram return 400
 * "can't parse entities" (the `_` opened an italic span that never closed),
 * which the listener classifier then surfaced to the user as a misleading
 * "invalid Telegram chat id" dialog.
 *
 * The function only needs to handle Telegram legacy-Markdown specials:
 * `_`, `*`, `` ` ``, `[`, `]`.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub the deps so importing telegram.ts doesn't drag electron / agent
// modules into the test process.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
vi.mock('./away-mode', () => ({
  isAwayMode: () => false,
  setAwayMode: vi.fn(),
}));
vi.mock('./tab-watcher', () => ({ snapshotTabs: () => [] }));
vi.mock('./tools', () => ({
  setSyncCallback: vi.fn(),
  getSyncedProjects: () => [],
}));
vi.mock('../agent', () => ({
  sendFromInternal: vi.fn(),
  registerOutputObserver: vi.fn(() => () => {}),
  stopFromInternal: vi.fn(),
  isAgentTab: () => false,
}));
vi.mock('./telegram-mode', () => ({
  resolveAlias: vi.fn(),
  buildUseCommands: () => [],
  formatProjectsList: () => '',
  aliasOrFallback: (name: string) => name,
}));

import { escapeTelegramMarkdown } from './telegram';

describe('escapeTelegramMarkdown', () => {
  it('escapes underscores (the actual /use_<alias> regression)', () => {
    expect(escapeTelegramMarkdown('shelf_terminal')).toBe('shelf\\_terminal');
    expect(escapeTelegramMarkdown('a_b_c')).toBe('a\\_b\\_c');
  });

  it('escapes asterisks', () => {
    expect(escapeTelegramMarkdown('*bold*')).toBe('\\*bold\\*');
  });

  it('escapes backticks', () => {
    expect(escapeTelegramMarkdown('`code`')).toBe('\\`code\\`');
  });

  it('escapes square brackets (link syntax)', () => {
    expect(escapeTelegramMarkdown('[label]')).toBe('\\[label\\]');
  });

  it('leaves safe characters alone', () => {
    expect(escapeTelegramMarkdown('hello world 123')).toBe('hello world 123');
    expect(escapeTelegramMarkdown('shelf-terminal')).toBe('shelf-terminal');
    expect(escapeTelegramMarkdown('我的專案')).toBe('我的專案');
    expect(escapeTelegramMarkdown('a.b.c')).toBe('a.b.c');
    expect(escapeTelegramMarkdown('user@host:/path')).toBe('user@host:/path');
  });

  it('handles mixed special and safe content', () => {
    expect(escapeTelegramMarkdown('my_project*v2')).toBe('my\\_project\\*v2');
  });

  it('handles empty string', () => {
    expect(escapeTelegramMarkdown('')).toBe('');
  });

  it('escapes parens... actually no — parens are NOT specials in legacy Markdown', () => {
    // Telegram legacy Markdown only treats _*`[] as specials. Parentheses
    // and dots are safe — overzealous escape would make text ugly.
    expect(escapeTelegramMarkdown('foo (bar)')).toBe('foo (bar)');
  });
});
