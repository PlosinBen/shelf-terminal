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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { net } from 'electron';

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

import { escapeTelegramMarkdown, startTelegram, maybeSendTyping, sendMessage } from './telegram';

const fetchMock = net.fetch as unknown as ReturnType<typeof vi.fn>;

// Build a Telegram-API Response stub. ok=true → apiCall returns json.result;
// ok=false → apiCall throws with .status (drives the parse-fallback path).
function apiResponse(result: unknown, opts?: { ok?: boolean; status?: number }) {
  const ok = opts?.ok ?? true;
  return {
    ok,
    status: opts?.status ?? (ok ? 200 : 400),
    text: async () => 'err',
    json: async () => ({ result }),
  };
}

// Decode which Telegram method + body a given fetch call used.
function callMethod(call: any[]): string {
  return String(call[0]).split('/').pop() ?? '';
}
function callBody(call: any[]): any {
  return JSON.parse(call[1].body);
}

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

// ── "typing…" indicator throttle ──
//
// The bridge refreshes Telegram's "typing…" chat action on every agent event
// while forwarding, throttled to ~once per 4s (the indicator self-expires
// after ~5s). Timestamp-only — no timer to manage. These lock down the
// send-on-activity + throttle-window behavior.
describe('maybeSendTyping throttle', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(apiResponse({}));
    // SHELF_TEST_MODE makes startTelegram set config + return before any
    // network call, so maybeSendTyping has a live config to send to.
    vi.stubEnv('SHELF_TEST_MODE', '1');
    startTelegram({ botToken: 'tok', chatId: 'chat' });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a typing chat action on first activity, then throttles within 4s and refreshes after', () => {
    // Start far ahead of the module-init lastTypingAt (0) so the first call
    // clears the 4s window deterministically.
    vi.setSystemTime(100_000);
    maybeSendTyping(); // first activity → sends
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callMethod(fetchMock.mock.calls[0])).toBe('sendChatAction');
    expect(callBody(fetchMock.mock.calls[0]).action).toBe('typing');

    vi.setSystemTime(102_000); // +2s → throttled
    maybeSendTyping();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(105_000); // +5s since last send → refresh
    maybeSendTyping();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── Plain-text send (agent-mode replies) ──
//
// Agent replies are sent with { plain: true } so a stray `_`/`*` in the
// agent's output can't 400 the whole message (the agent is also told to emit
// no Markdown). All other messages keep parse_mode=Markdown.
describe('sendMessage plain option', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(apiResponse({}));
    vi.stubEnv('SHELF_TEST_MODE', '1');
    startTelegram({ botToken: 'tok', chatId: 'chat' });
  });

  it('omits parse_mode when plain', async () => {
    await sendMessage('file_name with *stars*', { plain: true });
    expect(callBody(fetchMock.mock.calls[0]).parse_mode).toBeUndefined();
    expect(callBody(fetchMock.mock.calls[0]).text).toBe('file_name with *stars*');
  });

  it('keeps parse_mode=Markdown by default', async () => {
    await sendMessage('*bold*');
    expect(callBody(fetchMock.mock.calls[0]).parse_mode).toBe('Markdown');
  });
});
