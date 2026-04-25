import { describe, it, expect } from 'vitest';
import type { ChatMessage } from './llm-client';
import { trimHistoryForLLM } from './history-window';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistantText = (content: string): ChatMessage => ({ role: 'assistant', content });
const assistantCall = (id: string, name: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const toolResult = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  content,
  tool_call_id: id,
});

describe('trimHistoryForLLM', () => {
  it('returns history unchanged when shorter than max', () => {
    const h = [user('hi'), assistantText('hello')];
    expect(trimHistoryForLLM(h, 10)).toEqual(h);
  });

  it('returns slice as-is when boundary lands on a user turn', () => {
    const h = [
      user('first'), assistantText('reply 1'),
      user('second'), assistantText('reply 2'),
      user('third'), assistantText('reply 3'),
    ];
    // maxTurns=4 → slice(-4) starts at index 2 which is 'user'
    const result = trimHistoryForLLM(h, 4);
    expect(result).toEqual(h.slice(2));
    expect(result[0].role).toBe('user');
  });

  // Regression: this is the exact pattern that produced the Gemini 400.
  it('regression: walks back when boundary lands on assistant function_call', () => {
    const h = [
      user('first'),
      assistantCall('c1', 'scan_all_tabs'),  // index 1 — function_call
      toolResult('c1', '[...]'),
      assistantText('reply 1'),
      user('second'),
      assistantText('reply 2'),
    ];
    // maxTurns=5 → naive slice(-5) starts at index 1 (assistant function_call) — invalid
    const result = trimHistoryForLLM(h, 5);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('first');
    expect(result.length).toBe(6); // walked back to include user at 0
  });

  it('regression: walks back when boundary lands on orphan tool response', () => {
    const h = [
      user('first'),
      assistantCall('c1', 'foo'),
      toolResult('c1', 'res 1'),  // index 2 — function_response
      assistantText('reply'),
      user('second'),
    ];
    // maxTurns=3 → slice(-3) starts at index 2 (tool) — invalid
    const result = trimHistoryForLLM(h, 3);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('first');
  });

  it('walks back through multiple non-user messages at the boundary', () => {
    const h = [
      user('first'),
      assistantCall('c1', 'foo'),
      toolResult('c1', 'r1'),
      assistantCall('c2', 'bar'),  // index 3
      toolResult('c2', 'r2'),       // index 4
      assistantText('summary'),     // index 5
      user('second'),
    ];
    // maxTurns=4 → slice(-4) starts at index 3 (assistant function_call)
    const result = trimHistoryForLLM(h, 4);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('first');
    expect(result.length).toBe(7);
  });

  it('walks back when boundary lands on plain assistant text (defensive)', () => {
    const h = [
      user('first'),
      assistantText('reply 1'),  // index 1
      user('second'),
      assistantText('reply 2'),
    ];
    // maxTurns=3 → slice(-3) starts at index 1 (assistant text)
    const result = trimHistoryForLLM(h, 3);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('first');
  });

  it('returns from index 0 when no earlier user turn exists', () => {
    const h = [
      assistantCall('c1', 'foo'),
      toolResult('c1', 'r'),
      assistantText('reply'),
      user('only user'),
      assistantText('reply 2'),
    ];
    // maxTurns=3 → slice(-3) starts at index 2 (assistant text)
    // walking back hits index 0 without finding a user — return from 0
    const result = trimHistoryForLLM(h, 3);
    expect(result).toEqual(h);
  });

  it('handles exact maxTurns length without trimming', () => {
    const h = [user('a'), assistantText('b'), user('c'), assistantText('d')];
    expect(trimHistoryForLLM(h, 4)).toEqual(h);
  });
});
