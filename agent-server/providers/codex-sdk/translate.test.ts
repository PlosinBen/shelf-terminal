import { describe, expect, it } from 'vitest';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { renderCodexTodoList, translateCodexThreadEvent, translateCodexThreadItem } from './translate';

describe('translateCodexThreadEvent', () => {
  it('maps thread.started to context persistence and streaming status', () => {
    expect(translateCodexThreadEvent({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { type: 'context_patch', patch: { lastSdkSessionId: 'thread-1' } },
      { type: 'status', state: 'streaming', sessionId: 'thread-1' },
    ]);
  });

  it('drops turn.started lifecycle noise', () => {
    expect(translateCodexThreadEvent({ type: 'turn.started' })).toEqual([]);
  });

  it('maps turn.completed usage into a non-terminal status update', () => {
    expect(translateCodexThreadEvent({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_write_input_tokens: 1,
        output_tokens: 3,
        reasoning_output_tokens: 4,
      },
    })).toEqual([{ type: 'status', state: 'streaming', inputTokens: 10, outputTokens: 3 }]);
  });

  it('maps turn.failed and stream error to visible errors', () => {
    expect(translateCodexThreadEvent({ type: 'turn.failed', error: { message: 'boom' } })).toEqual([
      { type: 'error', error: 'codex: boom' },
    ]);
    expect(translateCodexThreadEvent({ type: 'error', message: 'stream broke' })).toEqual([
      { type: 'error', error: 'codex: stream broke' },
    ]);
  });

  it('fails loud on unknown raw event discriminants', () => {
    expect(translateCodexThreadEvent({ type: 'new.future.event' } as unknown as ThreadEvent)).toEqual([
      { type: 'error', error: 'codex: unsupported SDK event type "new.future.event"' },
    ]);
  });

  it('redacts configured secrets in event output', () => {
    const out = translateCodexThreadEvent(
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'echo ok',
          aggregated_output: 'token=secret-value',
          status: 'completed',
        },
      },
      { redactValues: ['secret-value'] },
    );
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(JSON.stringify(out)).toContain('[REDACTED]');
  });
});

describe('translateCodexThreadItem', () => {
  it('maps agent messages to replies', () => {
    expect(translateCodexThreadItem({ id: 'm1', type: 'agent_message', text: 'hello' })).toEqual([
      { type: 'message', msgId: 'm1', msgType: 'reply', content: 'hello' },
    ]);
  });

  it('maps reasoning to muted fold_text', () => {
    expect(translateCodexThreadItem({ id: 'r1', type: 'reasoning', text: 'thinking' })).toEqual([
      { type: 'message', msgId: 'r1', msgType: 'fold_text', label: 'Reasoning', body: { content: 'thinking', tone: 'muted' } },
    ]);
  });

  it('maps command execution start/update/completion to the same fold_code msgId', () => {
    const pending: ThreadItem = { id: 'cmd-1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' };
    const done: ThreadItem = { ...pending, aggregated_output: 'ok', exit_code: 0, status: 'completed' };
    expect(translateCodexThreadItem(pending)[0]).toMatchObject({ msgId: 'cmd-1', msgType: 'fold_code', label: 'Command', subtitle: 'npm test' });
    expect(translateCodexThreadItem(done)[0]).toMatchObject({ msgId: 'cmd-1', body: { content: 'ok' } });
  });

  it('marks failed command execution as an error card', () => {
    expect(translateCodexThreadItem({
      id: 'cmd-2',
      type: 'command_execution',
      command: 'false',
      aggregated_output: 'no',
      exit_code: 1,
      status: 'failed',
    })[0]).toMatchObject({ msgType: 'fold_code', errorMessage: 'Command failed with exit code 1' });
  });

  it('maps file_change to a markdown summary, not a fake diff', () => {
    expect(translateCodexThreadItem({
      id: 'patch-1',
      type: 'file_change',
      status: 'completed',
      changes: [
        { path: 'src/a.ts', kind: 'add' },
        { path: 'src/b.ts', kind: 'update' },
      ],
    })).toEqual([{
      type: 'message',
      msgId: 'patch-1',
      msgType: 'fold_markdown',
      label: 'File changes',
      body: { content: '- add `src/a.ts`\n- update `src/b.ts`' },
    }]);
  });

  it('maps MCP tool calls to markdown cards with args and result text', () => {
    const out = translateCodexThreadItem({
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'shelf',
      tool: 'list_app_skills',
      arguments: { q: 'secret-free' },
      result: { content: [{ type: 'text', text: 'result text' }], structured_content: null },
      status: 'completed',
    });
    expect(out).toEqual([{
      type: 'message',
      msgId: 'mcp-1',
      msgType: 'fold_markdown',
      label: 'MCP tool',
      subtitle: 'shelf.list_app_skills',
      body: { content: 'Arguments:\n```json\n{\n  "q": "secret-free"\n}\n```\n\nResult:\nresult text' },
    }]);
  });

  it('maps failed MCP calls to error cards', () => {
    expect(translateCodexThreadItem({
      id: 'mcp-2',
      type: 'mcp_tool_call',
      server: 'bad',
      tool: 'boom',
      arguments: {},
      error: { message: 'failed to start' },
      status: 'failed',
    })[0]).toMatchObject({ msgType: 'fold_markdown', errorMessage: 'failed to start' });
  });

  it('maps web_search to a note', () => {
    expect(translateCodexThreadItem({ id: 'web-1', type: 'web_search', query: 'OpenAI Codex SDK' })).toEqual([
      { type: 'message', msgId: 'web-1', msgType: 'note', content: 'Web search: OpenAI Codex SDK' },
    ]);
  });

  it('maps todo_list to plan replace semantics, including empty clear', () => {
    expect(renderCodexTodoList([
      { text: 'done', completed: true },
      { text: 'next', completed: false },
    ])).toBe('- [x] done\n- [ ] next');
    expect(translateCodexThreadItem({ id: 'todo-1', type: 'todo_list', items: [] })).toEqual([{ type: 'plan', content: '' }]);
  });

  it('maps item error to an inline error', () => {
    expect(translateCodexThreadItem({ id: 'err-1', type: 'error', message: 'bad item' })).toEqual([
      { type: 'message', msgId: 'err-1', msgType: 'error', content: 'bad item' },
    ]);
  });

  it('fails loud on unknown raw item discriminants', () => {
    expect(translateCodexThreadItem({ id: 'future-1', type: 'future_item' } as unknown as ThreadItem)).toEqual([
      { type: 'error', error: 'codex: unsupported SDK item type "future_item"' },
    ]);
  });
});
