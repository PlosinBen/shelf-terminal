import { describe, it, expect } from 'vitest';
import {
  needsCompaction,
  splitForCompaction,
  truncateToolOutputs,
  buildCompactionPrompt,
  COMPACTION_BUFFER,
  COMPACTION_MIN_TOKENS,
  TOOL_OUTPUT_MAX_CHARS,
  type HistoryMessage,
} from './compaction';

describe('needsCompaction', () => {
  it('returns false when tokens below minimum', () => {
    expect(needsCompaction(10_000, 128_000)).toBe(false);
  });

  it('returns false when tokens above minimum but within buffer', () => {
    expect(needsCompaction(100_000, 128_000)).toBe(false);
  });

  it('returns true when tokens exceed context - buffer', () => {
    expect(needsCompaction(125_000, 128_000)).toBe(true);
  });

  it('returns true at exact boundary', () => {
    const contextWindow = 128_000;
    expect(needsCompaction(contextWindow - COMPACTION_BUFFER + 1, contextWindow)).toBe(true);
  });

  it('returns false at exact boundary minus one', () => {
    const contextWindow = 128_000;
    expect(needsCompaction(contextWindow - COMPACTION_BUFFER, contextWindow)).toBe(false);
  });
});

describe('splitForCompaction', () => {
  const msgs: HistoryMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'reply 2' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'reply 3' },
  ];

  it('keeps last 2 user turns in tail by default', () => {
    const { head, tail } = splitForCompaction(msgs);
    expect(head).toHaveLength(2);
    expect(head[0].content).toBe('first');
    expect(tail).toHaveLength(4);
    expect(tail[0].content).toBe('second');
  });

  it('returns empty head when fewer turns than requested', () => {
    const short: HistoryMessage[] = [
      { role: 'user', content: 'only one' },
      { role: 'assistant', content: 'reply' },
    ];
    const { head, tail } = splitForCompaction(short);
    expect(head).toHaveLength(0);
    expect(tail).toHaveLength(2);
  });

  it('respects custom tailTurns', () => {
    const { head, tail } = splitForCompaction(msgs, 1);
    expect(tail[0].content).toBe('third');
    expect(head).toHaveLength(4);
  });
});

describe('truncateToolOutputs', () => {
  it('does not modify messages without tool calls', () => {
    const msgs: HistoryMessage[] = [{ role: 'user', content: 'hi' }];
    expect(truncateToolOutputs(msgs)).toEqual(msgs);
  });

  it('truncates tool results exceeding max chars', () => {
    const longResult = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 500);
    const msgs: HistoryMessage[] = [{
      role: 'assistant',
      content: 'using tool',
      toolCalls: [{ id: '1', toolName: 'Read', input: { path: 'a.ts' }, result: longResult }],
    }];
    const result = truncateToolOutputs(msgs);
    expect(result[0].toolCalls![0].result!.length).toBeLessThan(longResult.length);
    expect(result[0].toolCalls![0].result).toContain('truncated');
  });

  it('does not truncate short results', () => {
    const msgs: HistoryMessage[] = [{
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: '1', toolName: 'Read', input: {}, result: 'short' }],
    }];
    const result = truncateToolOutputs(msgs);
    expect(result[0].toolCalls![0].result).toBe('short');
  });
});

describe('buildCompactionPrompt', () => {
  it('builds prompt from messages', () => {
    const msgs: HistoryMessage[] = [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'looking into it' },
    ];
    const prompt = buildCompactionPrompt(msgs);
    expect(prompt).toContain('[user] fix the bug');
    expect(prompt).toContain('[assistant] looking into it');
    expect(prompt).toContain('Goal');
  });

  it('skips system messages', () => {
    const msgs: HistoryMessage[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ];
    const prompt = buildCompactionPrompt(msgs);
    expect(prompt).not.toContain('[system]');
    expect(prompt).toContain('[user] hi');
  });

  it('includes tool call info', () => {
    const msgs: HistoryMessage[] = [{
      role: 'assistant',
      content: 'reading file',
      toolCalls: [{ id: '1', toolName: 'Read', input: { path: 'a.ts' }, result: 'content' }],
    }];
    const prompt = buildCompactionPrompt(msgs);
    expect(prompt).toContain('[tool:Read]');
    expect(prompt).toContain('a.ts');
  });
});
