/**
 * Tests for the Telegram bridge's reply accumulator.
 *
 * Design constraint being verified: the accumulator is streaming-status
 * agnostic. Earlier inline buffer logic in telegram.ts coupled buffer reset
 * to `status streaming` events, which broke when claude emits multiple
 * mid-turn streaming refreshes (agent-server/providers/claude/index.ts
 * ~line 1008). Symptom: telegram only ever received the
 * "(turn ended with no reply — open Shelf for details)" fallback.
 *
 * The fix: accumulator just appends every `reply` and flushes on `idle`,
 * with turn-start reset handled explicitly by the caller (routeMessageToAgent).
 * Streaming events are completely ignored.
 */
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../agent/types';
import { AgentReplyAccumulator } from './telegram-bridge-accumulator';

const streaming = (): AgentEvent => ({ type: 'status', payload: { state: 'streaming' } });
const idle = (): AgentEvent => ({ type: 'status', payload: { state: 'idle' } });
const reply = (content: string): AgentEvent => ({
  type: 'message',
  payload: { msgId: `m-${content}`, type: 'reply', content },
});

describe('AgentReplyAccumulator — basic flush', () => {
  it('flushes the reply content on reply → idle', () => {
    const a = new AgentReplyAccumulator();
    expect(a.onEvent(reply('hello'))).toBeNull();
    expect(a.onEvent(idle())).toEqual({ flush: 'hello' });
  });

  it('concatenates multiple reply blocks within one turn', () => {
    const a = new AgentReplyAccumulator();
    a.onEvent(reply('hello '));
    a.onEvent(reply('world'));
    expect(a.onEvent(idle())).toEqual({ flush: 'hello world' });
  });

  it('flushes empty when no reply arrived (tool-only turn)', () => {
    const a = new AgentReplyAccumulator();
    expect(a.onEvent(idle())).toEqual({ flush: '' });
  });
});

describe('AgentReplyAccumulator — streaming-agnostic regression', () => {
  it('ignores streaming events entirely (no buffer wipe on mid-turn streaming)', () => {
    // Exact wire shape claude produces: reply, streaming-with-tokens, idle.
    // The buggy version cleared the buffer on streaming and flushed "" →
    // telegram showed the fallback message.
    const a = new AgentReplyAccumulator();
    a.onEvent(streaming()); // turn start — no-op for accumulator
    a.onEvent(reply('the actual answer'));
    a.onEvent(streaming()); // mid-turn token refresh — no-op
    expect(a.onEvent(idle())).toEqual({ flush: 'the actual answer' });
  });

  it('handles many streaming events interleaved with replies', () => {
    // Multi-step agentic loop: stream, reply, stream, reply, stream, idle.
    const a = new AgentReplyAccumulator();
    a.onEvent(streaming());
    a.onEvent(reply('part 1 '));
    a.onEvent(streaming());
    a.onEvent(reply('part 2 '));
    a.onEvent(streaming());
    a.onEvent(reply('part 3'));
    expect(a.onEvent(idle())).toEqual({ flush: 'part 1 part 2 part 3' });
  });
});

describe('AgentReplyAccumulator — turn boundaries', () => {
  it('starts a fresh turn after idle without leaking previous content', () => {
    const a = new AgentReplyAccumulator();
    a.onEvent(reply('first turn'));
    expect(a.onEvent(idle())).toEqual({ flush: 'first turn' });

    a.onEvent(reply('second turn'));
    expect(a.onEvent(idle())).toEqual({ flush: 'second turn' });
  });

  it('reset() wipes pending buffer', () => {
    const a = new AgentReplyAccumulator();
    a.onEvent(reply('dropped on reset'));
    a.reset();
    expect(a.onEvent(idle())).toEqual({ flush: '' });

    a.onEvent(reply('fresh content'));
    expect(a.onEvent(idle())).toEqual({ flush: 'fresh content' });
  });
});
