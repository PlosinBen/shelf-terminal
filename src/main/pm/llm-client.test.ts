/**
 * toModelMessages — adapts PM's internal OpenAI-style ChatMessage[] to
 * ai-sdk v6's strict ModelMessage[] schema. The earlier loose adapter
 * (`messages as any` passed straight through) blew up at runtime once
 * `ai` v6 added stricter zod validation, see GOTCHAS "ai-sdk v6 ModelMessage
 * schema breaks PM's OpenAI-style tool messages".
 */
import { describe, it, expect } from 'vitest';
import { toModelMessages, type ChatMessage } from './llm-client';

const sys = (text: string): ChatMessage => ({ role: 'system', content: text });
const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const assistantText = (text: string): ChatMessage => ({ role: 'assistant', content: text });
const assistantCall = (id: string, name: string, args: string = '{}'): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const assistantTextAndCall = (text: string, id: string, name: string): ChatMessage => ({
  role: 'assistant',
  content: text,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const toolResult = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  content,
  tool_call_id: id,
});

describe('toModelMessages', () => {
  it('pulls system message out into the `system` field', () => {
    const { system, modelMessages } = toModelMessages([sys('You are PM'), user('hi')]);
    expect(system).toBe('You are PM');
    expect(modelMessages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('concatenates multiple system messages (rare but legal)', () => {
    const { system } = toModelMessages([sys('Part one'), sys('Part two'), user('hi')]);
    expect(system).toBe('Part one\n\nPart two');
  });

  it('returns undefined system when there is no system message', () => {
    const { system, modelMessages } = toModelMessages([user('hi')]);
    expect(system).toBeUndefined();
    expect(modelMessages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps plain assistant text messages as content array', () => {
    const { modelMessages } = toModelMessages([user('hi'), assistantText('hello there')]);
    expect(modelMessages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
    ]);
  });

  it('converts assistant tool_calls (content:null) into tool-call parts', () => {
    const { modelMessages } = toModelMessages([
      user('list tabs'),
      assistantCall('call_1', 'scan_all_tabs'),
    ]);
    expect(modelMessages).toEqual([
      { role: 'user', content: 'list tabs' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'scan_all_tabs', input: {} },
        ],
      },
    ]);
  });

  it('parses JSON arguments into input object', () => {
    const { modelMessages } = toModelMessages([
      user('read tab'),
      assistantCall('call_1', 'read_scrollback', '{"tabId":"abc","lines":50}'),
    ]);
    const asst = modelMessages[1] as any;
    expect(asst.content[0].input).toEqual({ tabId: 'abc', lines: 50 });
  });

  it('falls back to empty object when arguments JSON is malformed', () => {
    const { modelMessages } = toModelMessages([
      user('x'),
      assistantCall('call_1', 'foo', 'not-json{{{'),
    ]);
    const asst = modelMessages[1] as any;
    expect(asst.content[0].input).toEqual({});
  });

  it('combines assistant text and tool-call in same content array', () => {
    const { modelMessages } = toModelMessages([
      user('plan'),
      assistantTextAndCall('let me check', 'call_1', 'scan_all_tabs'),
    ]);
    const asst = modelMessages[1] as any;
    expect(asst.content).toEqual([
      { type: 'text', text: 'let me check' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'scan_all_tabs', input: {} },
    ]);
  });

  it('converts tool result into tool-result content array with toolName from preceding call', () => {
    const { modelMessages } = toModelMessages([
      user('list'),
      assistantCall('call_1', 'scan_all_tabs'),
      toolResult('call_1', '[tab1, tab2]'),
    ]);
    expect(modelMessages[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'scan_all_tabs',
          output: { type: 'text', value: '[tab1, tab2]' },
        },
      ],
    });
  });

  it('uses "unknown" toolName when preceding assistant call is missing (truncated history)', () => {
    // Sliding window may chop the assistant tool_call message but keep the
    // tool result. We must not throw — fall back to 'unknown'.
    const { modelMessages } = toModelMessages([
      user('list'),
      toolResult('call_orphan', '(empty)'),
    ]);
    const tool = modelMessages[1] as any;
    expect(tool.content[0].toolName).toBe('unknown');
    expect(tool.content[0].toolCallId).toBe('call_orphan');
  });

  it('handles multi-round tool sequences (assistant→tool→assistant→tool)', () => {
    const { modelMessages } = toModelMessages([
      user('do stuff'),
      assistantCall('c1', 'tool_a'),
      toolResult('c1', 'result a'),
      assistantCall('c2', 'tool_b'),
      toolResult('c2', 'result b'),
    ]);
    expect((modelMessages[2] as any).content[0].toolName).toBe('tool_a');
    expect((modelMessages[4] as any).content[0].toolName).toBe('tool_b');
  });

  it('falls back to empty-text part when assistant has neither content nor tool_calls', () => {
    // Defensive: PM's loop shouldn't push this, but the adapter must not
    // emit content:[] (ai-sdk schema rejects empty content array).
    const { modelMessages } = toModelMessages([
      { role: 'assistant', content: '' },
    ]);
    expect(modelMessages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
    });
  });

  it('coerces null user content to empty string', () => {
    const { modelMessages } = toModelMessages([
      { role: 'user', content: null as any },
    ]);
    expect(modelMessages[0]).toEqual({ role: 'user', content: '' });
  });
});
