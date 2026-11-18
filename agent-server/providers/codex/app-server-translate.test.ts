import { describe, expect, it, vi } from 'vitest';
import * as serverLogger from '../../server-logger';
import { CODEX_PLAN_UPDATED, summarizeTokenUsageForLog, tokenUsageToContextSegment, translateCodexAppServerNotification } from './app-server-translate';

describe('translateCodexAppServerNotification', () => {
  it('redacts plan steps and treats an empty snapshot as a clear even with explanation', () => {
    expect(translateCodexAppServerNotification(CODEX_PLAN_UPDATED, {
      plan: [{ step: 'inspect secret', status: 'pending' }], explanation: 'Updated tasks',
    }, { redactValues: ['secret'] })).toEqual([{ type: 'plan', content: '- [ ] inspect [REDACTED]' }]);
    expect(translateCodexAppServerNotification(CODEX_PLAN_UPDATED, {
      plan: [], explanation: 'Finished',
    })).toEqual([{ type: 'plan', content: '' }]);
  });

  it.each([undefined, null, {}, [null], [{ step: 'private-task', status: 'unknown' }], [
    { step: 'valid', status: 'completed' }, { status: 'pending' },
  ]])('rejects malformed plan snapshots without emitting partial or empty state: %j', plan => {
    const log = vi.spyOn(serverLogger, 'serverLog').mockImplementation(() => {});
    try {
      expect(translateCodexAppServerNotification(CODEX_PLAN_UPDATED, { threadId: 'thread', turnId: 'turn', plan })).toEqual([]);
      expect(log).toHaveBeenCalledWith('warn', 'codex-app-server', 'Invalid turn plan snapshot', expect.objectContaining({ threadId: 'thread', turnId: 'turn' }));
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-task');
    } finally { log.mockRestore(); }
  });

  it('keeps plan-mode text items supported separately from task updates', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: { id: 'plan-mode-1', type: 'plan', text: 'Proposed approach' },
    })).toEqual([{ type: 'plan', content: 'Proposed approach' }]);
  });
  // File Diff settings must govern the whole file, including separated edits.
  // Keep this representative case across provider, wire and UI coverage.
  it('splits multiple files into file diff cards without joining separated hunks', () => {
    const messages = translateCodexAppServerNotification('item/completed', {
      item: { id: 'multi-file', type: 'fileChange', status: 'completed', changes: [
        { path: 'a.ts', kind: { type: 'update' }, diff: '@@ -2,3 +2,3 @@\n context\n-before\n+after\n end\n@@ -16,2 +16,3 @@\n-old\n+new\n+inserted\n tail\n' },
        { path: 'b.ts', kind: { type: 'update' }, diff: '@@ -20 +20 @@\n-old-b\n+new-b\n' },
      ] },
    });
    expect(messages).toMatchObject([
      { msgType: 'fold_diff', subtitle: 'a.ts', body: { diff: { hunks: [
        { oldStart: 2, newStart: 2, oldLines: ['context', 'before', 'end'], newLines: ['context', 'after', 'end'] },
        { oldStart: 16, newStart: 16, oldLines: ['old', 'tail'], newLines: ['new', 'inserted', 'tail'] },
      ] } } },
      { msgType: 'fold_diff', subtitle: 'b.ts', body: { diff: { hunks: [
        { oldStart: 20, newStart: 20, oldLines: ['old-b'], newLines: ['new-b'] },
      ] } } },
    ]);
  });
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

  it('suppresses empty reasoning items', () => {
    expect(translateCodexAppServerNotification('item/started', {
      item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] },
    })).toEqual([]);
  });

  it.each(['webSearch', 'web_search'])('maps %s items to bodyless markdown cards', (type) => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'search-1',
        type,
        query: 'Codex app server protocol',
        results: [{ title: 'Ignored result' }],
      },
    })).toEqual([{
      type: 'message',
      msgId: 'search-1',
      msgType: 'fold_markdown',
      label: 'Web search',
      subtitle: 'Codex app server protocol',
    }]);
  });

  it('suppresses web search items without a query', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: { id: 'search-1', type: 'webSearch' },
    })).toEqual([]);
    expect(translateCodexAppServerNotification('item/completed', {
      item: { id: 'search-2', type: 'webSearch', query: '' },
    })).toEqual([]);
  });

  it('maps command execution items to fold_code cards', () => {
    expect(translateCodexAppServerNotification('item/updated', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'npm test',
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
      },
    })).toEqual([
      { type: 'message', msgId: 'cmd-1', msgType: 'fold_code', label: 'Command', subtitle: 'npm test' },
    ]);
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'npm test',
        status: 'completed',
        aggregatedOutput: 'ok',
        exitCode: 0,
      },
    })).toEqual([
      { type: 'message', msgId: 'cmd-1', msgType: 'fold_code', label: 'Command', subtitle: 'npm test', body: { content: 'ok' } },
    ]);
  });

  it('marks completed command executions with no output explicitly', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'true',
        status: 'completed',
        aggregatedOutput: null,
        exitCode: 0,
      },
    })).toEqual([
      {
        type: 'message',
        msgId: 'cmd-1',
        msgType: 'fold_code',
        label: 'Command',
        subtitle: 'true',
        body: { content: '(no output)' },
      },
    ]);
  });

  it('marks failed command execution as an error card', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'false',
        status: 'failed',
        aggregatedOutput: 'no',
        exitCode: 1,
      },
    })).toEqual([
      {
        type: 'message',
        msgId: 'cmd-1',
        msgType: 'fold_code',
        label: 'Command',
        subtitle: 'false',
        errorMessage: 'Command failed with exit code 1',
        body: { content: 'no' },
      },
    ]);
  });

  it('maps a single object-kind update to a hunk diff', () => {
    expect(translateCodexAppServerNotification('item/completed', { item: {
      id: 'file-1', type: 'fileChange', status: 'completed', changes: [
        { path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
      ],
    } })).toMatchObject([{ msgType: 'fold_diff', subtitle: 'a.ts', body: { diff: { hunks: [
      { oldStart: 1, newStart: 1, oldLines: ['old'], newLines: ['new'] },
    ] } } }]);
  });

  it('redacts file paths and multiline content without losing hunk row counts', () => {
    const out = translateCodexAppServerNotification('item/completed', { item: {
      id: 'redact', type: 'fileChange', changes: [
        { path: '/secret/a.ts', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n-one\n-two\n+three\n+four\n' },
      ],
    } }, { redactValues: ['/secret', 'one\ntwo'] });
    expect(out).toMatchObject([{ subtitle: '[REDACTED]/a.ts', body: { diff: { hunks: [
      { oldLines: ['[REDACTED]', '[REDACTED]'], newLines: ['three', 'four'] },
    ] } } }]);
    expect(JSON.stringify(out)).not.toContain('/secret');
  });

  it('maps MCP and dynamic tool calls to markdown cards', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'shelf',
        tool: 'list_app_skills',
        status: 'completed',
        arguments: { appId: 'app-1' },
        result: { content: [{ type: 'text', text: 'done' }] },
        error: null,
      },
    })).toEqual([
      {
        type: 'message',
        msgId: 'mcp-1',
        msgType: 'fold_markdown',
        label: 'MCP tool',
        subtitle: 'shelf.list_app_skills',
        body: { content: 'Arguments:\n```json\n{\n  "appId": "app-1"\n}\n```\n\nResult:\ndone' },
      },
    ]);
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'dyn-1',
        type: 'dynamicToolCall',
        namespace: 'custom',
        tool: 'fetch',
        arguments: { url: 'https://example.com' },
        status: 'failed',
        contentItems: [{ type: 'inputText', text: 'boom' }],
        success: false,
      },
    })).toEqual([
      {
        type: 'message',
        msgId: 'dyn-1',
        msgType: 'fold_markdown',
        label: 'Tool',
        subtitle: 'custom.fetch',
        errorMessage: 'Tool call failed',
        body: { content: 'Arguments:\n```json\n{\n  "url": "https://example.com"\n}\n```\n\nOutput:\nboom' },
      },
    ]);
  });

  it('maps token usage updates to context status', () => {
    expect(translateCodexAppServerNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { totalTokens: 237_005 },
        last: { inputTokens: 14_654, totalTokens: 14_689 },
        modelContextWindow: 258_400,
      },
    })).toEqual([
      { type: 'status', state: 'streaming', contextUsage: { text: 'ctx: 6%', severity: 'normal' } },
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
      last: { inputTokens: 4_100, totalTokens: 4_278 },
      modelContextWindow: 258_400,
      prompt: 'must not be logged',
    })).toEqual({
      cumulativeTotalTokens: 221_900,
      lastInputTokens: 4_100,
      lastTotalTokens: 4_278,
      modelContextWindow: 258_400,
      cumulativePercent: 86,
      lastPercent: 2,
    });
  });
});
