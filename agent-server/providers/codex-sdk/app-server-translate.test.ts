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

  it('suppresses empty reasoning items', () => {
    expect(translateCodexAppServerNotification('item/started', {
      item: { id: 'reason-1', type: 'reasoning', summary: [], content: [] },
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

  it('maps a single unified file change to a fold_diff card', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'file-1',
        type: 'fileChange',
        status: 'completed',
        changes: [
          { path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n' },
        ],
      },
    })).toEqual([
      {
        type: 'message',
        msgId: 'file-1',
        msgType: 'fold_diff',
        label: 'File changes',
        subtitle: 'a.ts',
        body: { diff: { oldString: 'old', newString: 'new' } },
      },
    ]);
  });

  it('falls back to markdown for multi-file or non-unified file changes', () => {
    expect(translateCodexAppServerNotification('item/completed', {
      item: {
        id: 'file-1',
        type: 'fileChange',
        status: 'completed',
        changes: [
          { path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
          { path: 'b.ts', kind: 'add', diff: '' },
        ],
      },
    })).toEqual([
      {
        type: 'message',
        msgId: 'file-1',
        msgType: 'fold_markdown',
        label: 'File changes',
        body: { content: '- update `a.ts`\n```diff\n@@ -1 +1 @@\n-old\n+new\n```\n- add `b.ts`' },
      },
    ]);
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
