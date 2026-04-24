import { describe, it, expect } from 'vitest';
import type { PmToolCall } from '@shared/types';
import { initialPmStreamState, pmStreamReducer, type PmStreamState } from './pm-view-reducer';

const retryErrorMsg = 'LLM API error 429: rate limited\n\nRetrying in 5s... (1/3)';
const finalErrorMsg = 'LLM API error 500: upstream failure';

describe('pmStreamReducer', () => {
  it('send_start resets stream state and marks streaming', () => {
    const prev: PmStreamState = {
      streaming: false,
      streamText: 'stale',
      streamToolCalls: [{ id: 'a', name: 'foo', args: {} }],
      error: 'stale banner',
    };
    const next = pmStreamReducer(prev, { type: 'send_start' });
    expect(next).toEqual({ streaming: true, streamText: '', streamToolCalls: [], error: null });
  });

  it('dismiss_error clears error banner without touching stream', () => {
    const prev: PmStreamState = {
      streaming: true,
      streamText: 'partial',
      streamToolCalls: [{ id: 'tc1', name: 'foo', args: {} }],
      error: 'banner',
    };
    const next = pmStreamReducer(prev, { type: 'dismiss_error' });
    expect(next.error).toBeNull();
    expect(next.streaming).toBe(true);
    expect(next.streamText).toBe('partial');
    expect(next.streamToolCalls).toEqual([{ id: 'tc1', name: 'foo', args: {} }]);
  });

  it('clear_display wipes stream text and tool calls only', () => {
    const prev: PmStreamState = {
      streaming: true,
      streamText: 'hello',
      streamToolCalls: [{ id: 'a', name: 'foo', args: {} }],
      error: 'banner',
    };
    const next = pmStreamReducer(prev, { type: 'clear_display' });
    expect(next).toEqual({ streaming: true, streamText: '', streamToolCalls: [], error: 'banner' });
  });

  it('text chunk appends to streamText', () => {
    const prev = { ...initialPmStreamState, streaming: true, streamText: 'Hi ' };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'text', text: 'there' } });
    expect(next.streamText).toBe('Hi there');
  });

  it('tool_start chunk appends to streamToolCalls', () => {
    const tc: PmToolCall = { id: 'tc1', name: 'scan_all_tabs', args: {} };
    const prev = { ...initialPmStreamState, streaming: true };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'tool_start', toolCall: tc } });
    expect(next.streamToolCalls).toEqual([tc]);
  });

  it('tool_result chunk replaces matching tool call by id', () => {
    const pending: PmToolCall = { id: 'tc1', name: 'scan_all_tabs', args: {} };
    const completed: PmToolCall = { ...pending, result: '[{"projectId":"..."}]' };
    const prev = { ...initialPmStreamState, streaming: true, streamToolCalls: [pending] };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'tool_result', toolCall: completed } });
    expect(next.streamToolCalls).toEqual([completed]);
  });

  it('tool_result chunk with unknown id is a no-op for the list', () => {
    const existing: PmToolCall = { id: 'tc1', name: 'foo', args: {} };
    const orphan: PmToolCall = { id: 'tc2', name: 'bar', args: {}, result: 'x' };
    const prev = { ...initialPmStreamState, streaming: true, streamToolCalls: [existing] };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'tool_result', toolCall: orphan } });
    expect(next.streamToolCalls).toEqual([existing]);
  });

  it('done chunk resets to initial state', () => {
    const prev: PmStreamState = {
      streaming: true,
      streamText: 'some reply',
      streamToolCalls: [{ id: 'tc1', name: 'foo', args: {}, result: 'done' }],
      error: null,
    };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'done' } });
    expect(next).toEqual(initialPmStreamState);
  });

  it('retrying error sets banner without resetting streaming', () => {
    const prev: PmStreamState = {
      streaming: true,
      streamText: 'partial',
      streamToolCalls: [],
      error: null,
    };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'error', error: retryErrorMsg } });
    expect(next.error).toBe(retryErrorMsg);
    expect(next.streaming).toBe(true);
    expect(next.streamText).toBe('partial');
  });

  it('final (non-retrying) error resets all stream state', () => {
    const prev: PmStreamState = {
      streaming: true,
      streamText: 'partial',
      streamToolCalls: [{ id: 'tc1', name: 'foo', args: {} }],
      error: 'earlier banner',
    };
    const next = pmStreamReducer(prev, { type: 'chunk', chunk: { type: 'error', error: finalErrorMsg } });
    expect(next).toEqual(initialPmStreamState);
  });

  // Regression: see GOTCHAS #33 (to be added). Retry succeeded, done chunk
  // arrives — banner must not stick around on top of the new reply.
  it('regression: done chunk clears stale retry banner', () => {
    const withBanner: PmStreamState = {
      streaming: true,
      streamText: '',
      streamToolCalls: [],
      error: retryErrorMsg,
    };
    const next = pmStreamReducer(withBanner, { type: 'chunk', chunk: { type: 'done' } });
    expect(next.error).toBeNull();
  });

  // Regression: as soon as any success chunk arrives (text/tool_start/...),
  // the retry banner should be cleared so the user isn't left staring at it.
  it('regression: text chunk after retry banner clears the banner immediately', () => {
    let state: PmStreamState = { ...initialPmStreamState, streaming: true };
    state = pmStreamReducer(state, { type: 'chunk', chunk: { type: 'error', error: retryErrorMsg } });
    expect(state.error).toBe(retryErrorMsg);

    state = pmStreamReducer(state, { type: 'chunk', chunk: { type: 'text', text: 'Hello' } });
    expect(state.error).toBeNull();
    expect(state.streamText).toBe('Hello');
  });

  it('regression: tool_start chunk after retry banner clears the banner', () => {
    const withBanner: PmStreamState = {
      streaming: true,
      streamText: '',
      streamToolCalls: [],
      error: retryErrorMsg,
    };
    const tc: PmToolCall = { id: 'tc1', name: 'scan_all_tabs', args: {} };
    const next = pmStreamReducer(withBanner, { type: 'chunk', chunk: { type: 'tool_start', toolCall: tc } });
    expect(next.error).toBeNull();
    expect(next.streamToolCalls).toEqual([tc]);
  });
});
