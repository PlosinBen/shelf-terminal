import { describe, it, expect } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { translateSessionUpdate, contentBlockToText, renderPlan } from './translate';

describe('translateSessionUpdate', () => {
  it('maps agent_message_chunk → stream(text)', () => {
    const u: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' }, messageId: 'm1' };
    expect(translateSessionUpdate(u)).toEqual([{ type: 'stream', msgId: 'm1', streamType: 'text', content: 'hello' }]);
  });

  it('maps agent_thought_chunk → stream(thinking)', () => {
    const u: SessionUpdate = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } };
    expect(translateSessionUpdate(u)).toEqual([{ type: 'stream', msgId: 'agent-message', streamType: 'thinking', content: 'pondering' }]);
  });

  it('drops empty/blank text chunks', () => {
    const u: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } };
    expect(translateSessionUpdate(u)).toEqual([]);
  });

  it('maps plan → plan side-channel markdown checklist', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'a', priority: 'high', status: 'completed' },
        { content: 'b', priority: 'medium', status: 'in_progress' },
        { content: 'c', priority: 'low', status: 'pending' },
      ],
    };
    expect(translateSessionUpdate(u)).toEqual([{ type: 'plan', content: '- [x] a\n- [~] b\n- [ ] c' }]);
  });

  it('maps a diff tool_call → fold_diff', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit file.ts',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: '/x/file.ts', oldText: 'a', newText: 'b' }],
    };
    expect(translateSessionUpdate(u)).toEqual([{
      type: 'message', msgId: 't1', msgType: 'fold_diff', label: 'Edit file.ts', subtitle: 'edit',
      body: { diff: { oldString: 'a', newString: 'b' } },
    }]);
  });

  it('maps a non-diff tool_call → fold_code with concatenated text content', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Run',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'output line' } }],
    };
    expect(translateSessionUpdate(u)).toEqual([{
      type: 'message', msgId: 't2', msgType: 'fold_code', label: 'Run', subtitle: 'execute',
      body: { content: 'output line' },
    }]);
  });

  it('surfaces a failed tool_call as an error card', () => {
    const u: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Boom', status: 'failed' };
    const out = translateSessionUpdate(u);
    expect(out[0]).toMatchObject({ type: 'message', msgType: 'fold_code', errorMessage: 'Tool call failed' });
  });

  it('ignores non-timeline updates (mode/commands)', () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'current_mode_update', currentModeId: 'agent' },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
    ];
    for (const u of updates) expect(translateSessionUpdate(u)).toEqual([]);
  });
});

describe('contentBlockToText / renderPlan helpers', () => {
  it('extracts text and renders resource_link', () => {
    expect(contentBlockToText({ type: 'text', text: 'hi' })).toBe('hi');
    expect(contentBlockToText({ type: 'resource_link', uri: 'https://x', name: 'X' })).toBe('[X](https://x)');
  });

  it('renders an empty plan as empty string', () => {
    expect(renderPlan([])).toBe('');
  });
});
