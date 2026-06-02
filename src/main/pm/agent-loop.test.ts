import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatMessage, StreamEvent } from './llm-client';

// agent-loop has heavy side-effect deps (LLM streaming, tools, telegram,
// persisted history). Mock them so we can unit-test the retry/backoff logic
// (GOTCHAS #29: retryable 503/429/500/502/504, 3 retries, 5s→10s→20s).
const streamChat = vi.fn();
vi.mock('./llm-client', () => ({ streamChat: (...a: unknown[]) => streamChat(...a) }));
vi.mock('./tools', () => ({
  getActiveToolSchemas: () => [],
  executeTool: () => '',
  // getCurrentFocus is called by agent-loop's getSystemPrompt() to inject the
  // "Current Focus" section (DECISIONS-pm #66). Tests don't care about focus
  // routing — return null so PM falls back to scan-first behaviour.
  getCurrentFocus: () => null,
}));
vi.mock('./telegram', () => ({ sendPmResponse: vi.fn().mockResolvedValue(undefined), isRunning: () => false }));
vi.mock('./away-mode', () => ({ isAwayMode: () => false }));
vi.mock('./history-store', () => ({
  loadHistory: () => ({ chat: [], display: [] }),
  saveHistory: vi.fn(),
  clearPersistedHistory: vi.fn(),
}));

import { handlePmSend, stopGeneration, clearHistory, getHistory } from './agent-loop';

const config = { provider: 'gemini', apiKey: 'k', model: 'm' } as any;

interface FakeWin {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}
function makeWin(): FakeWin {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}
// Chunks pushed to the renderer via IPC.PM_STREAM (2nd arg of webContents.send).
function chunks(win: FakeWin) {
  return win.webContents.send.mock.calls.map((c) => c[1]);
}

/** A streamChat result that yields one text event then completes. */
async function* succeed(): AsyncGenerator<StreamEvent> {
  yield { type: 'text', text: 'ok' } as StreamEvent;
  yield { type: 'done' } as StreamEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearHistory();
  streamChat.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('handlePmSend retry/backoff (GOTCHAS #29)', () => {
  it('retries a 503 after 5s then succeeds', async () => {
    streamChat
      .mockImplementationOnce(() => { throw new Error('LLM API error 503: high demand'); })
      .mockImplementationOnce(succeed);

    const win = makeWin();
    const p = handlePmSend('hi', config, win as any);

    // First attempt threw → a "Retrying in 5s" error chunk is emitted, and we
    // must NOT have started the retry before the backoff elapses.
    await Promise.resolve();
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(chunks(win).some((c) => c.type === 'error' && /Retrying in 5s\.\.\. \(1\/3\)/.test(c.error))).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(streamChat).toHaveBeenCalledTimes(2);
    const cs = chunks(win);
    expect(cs.some((c) => c.type === 'text' && c.text === 'ok')).toBe(true);
    expect(cs.some((c) => c.type === 'done')).toBe(true);
  });

  it('does not retry a non-retryable error and surfaces it', async () => {
    streamChat.mockImplementationOnce(() => { throw new Error('boom'); });

    const win = makeWin();
    await handlePmSend('hi', config, win as any);

    expect(streamChat).toHaveBeenCalledTimes(1);
    const cs = chunks(win);
    const err = cs.find((c) => c.type === 'error');
    expect(err.error).toBe('boom');
    expect(err.error).not.toMatch(/Retrying/);
    // Non-retryable errors are persisted to the display history.
    expect(getHistory().at(-1)).toMatchObject({ role: 'error', content: 'boom' });
  });

  it('exhausts 3 retries with 5s→10s→20s backoff then gives up', async () => {
    streamChat.mockImplementation(() => { throw new Error('error 429 rate limited'); });

    const win = makeWin();
    const p = handlePmSend('hi', config, win as any);

    await Promise.resolve();
    expect(streamChat).toHaveBeenCalledTimes(1);     // attempt 0
    await vi.advanceTimersByTimeAsync(5000);
    expect(streamChat).toHaveBeenCalledTimes(2);     // attempt 1 (after 5s)
    await vi.advanceTimersByTimeAsync(10000);
    expect(streamChat).toHaveBeenCalledTimes(3);     // attempt 2 (after 10s)
    await vi.advanceTimersByTimeAsync(20000);
    expect(streamChat).toHaveBeenCalledTimes(4);     // attempt 3 (after 20s)
    await p;

    // Final failure: a plain error chunk without the "Retrying" suffix.
    const finalErr = chunks(win).filter((c) => c.type === 'error').at(-1);
    expect(finalErr.error).toBe('error 429 rate limited');
    expect(finalErr.error).not.toMatch(/Retrying/);
  });

  it('treats AbortError as a clean stop (done, no error chunk)', async () => {
    streamChat.mockImplementationOnce(() => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });

    const win = makeWin();
    await handlePmSend('hi', config, win as any);

    const cs = chunks(win);
    expect(cs.some((c) => c.type === 'done')).toBe(true);
    expect(cs.some((c) => c.type === 'error')).toBe(false);
  });
});

describe('stopGeneration', () => {
  it('is a no-op when no turn is in flight', () => {
    expect(() => stopGeneration()).not.toThrow();
  });
});
