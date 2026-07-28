import { describe, expect, it } from 'vitest';
import { summarizeTokenUsageForLog, tokenUsageToContextSegment, translateCodexAppServerNotification } from './app-server-translate';

describe('translateCodexAppServerNotification', () => {
  it('maps agent message deltas to text stream chunks', () => {
    expect(translateCodexAppServerNotification('item/agentMessage/delta', {
      itemId: 'item-1',
      delta: 'hello',
    })).toEqual([
      { type: 'stream', msgId: 'item-1', streamType: 'text', content: 'hello' },
    ]);
  });

  it('maps completed agent messages to reply upserts', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: { id: 'item-1', type: 'agentMessage', text: 'final' },
    })).toEqual([
      { type: 'message', msgId: 'item-1', msgType: 'reply', content: 'final' },
    ]);
  });

  it('maps context compaction completion to a system line', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: { id: 'compact-1', type: 'contextCompaction' },
    })).toEqual([
      { type: 'message', msgId: 'compact-1', msgType: 'system', content: 'Context compacted.' },
    ]);
  });

  it('maps token usage updates to context status', () => {
    expect(translateCodexAppServerNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { totalTokens: 129_200 },
        modelContextWindow: 258_400,
      },
    })).toEqual([
      { type: 'status', state: 'streaming', contextUsage: { text: 'ctx: 50%', severity: 'warning' } },
    ]);
  });

  it('maps running and idle thread status changes', () => {
    expect(translateCodexAppServerNotification('thread/status/changed', {
      threadStatus: { status: 'running' },
    })).toEqual([{ type: 'status', state: 'streaming' }]);
    expect(translateCodexAppServerNotification('thread/status/changed', {
      threadStatus: { status: 'idle' },
    })).toEqual([{ type: 'status', state: 'idle' }]);
  });

  it('ignores lifecycle notifications that do not directly affect Shelf state', () => {
    expect(translateCodexAppServerNotification('turn/completed', {})).toEqual([]);
    expect(translateCodexAppServerNotification('unknown/event', {})).toEqual([]);
  });

  it('redacts configured values from assistant text', () => {
    expect(translateCodexAppServerNotification('item/agentMessage/delta', {
      itemId: 'item-1',
      delta: 'token secret',
    }, { redactValues: ['secret'] })).toEqual([
      { type: 'stream', msgId: 'item-1', streamType: 'text', content: 'token [REDACTED]' },
    ]);
  });
});

describe('tokenUsageToContextSegment', () => {
  it('returns null for incomplete token usage shapes', () => {
    expect(tokenUsageToContextSegment({ total: { totalTokens: 1 } })).toBeNull();
    expect(tokenUsageToContextSegment({ modelContextWindow: 1 })).toBeNull();
  });
});

describe('summarizeTokenUsageForLog', () => {
  it('extracts only numeric context fields for diagnostics', () => {
    expect(summarizeTokenUsageForLog({
      total: { totalTokens: 221_900 },
      modelContextWindow: 258_400,
      prompt: 'must not be logged',
    })).toEqual({
      totalTokens: 221_900,
      modelContextWindow: 258_400,
      percent: 86,
    });
  });
});
