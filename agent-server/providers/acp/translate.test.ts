import { describe, it, expect } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { translateSessionUpdate, createToolMetaCarry, contentBlockToText, renderPlan } from './translate';

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
      // subtitle = the diff's file path (not the title), matching claude's Edit card.
      type: 'message', msgId: 't1', msgType: 'fold_diff', label: 'Edit', subtitle: '/x/file.ts',
      body: { diff: { oldString: 'a', newString: 'b' } },
    }]);
  });

  it('uses the file PATH as subtitle for copilot apply_patch (generic title), from the diff block', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'apply_patch', kind: 'edit', status: 'completed',
      content: [{ type: 'diff', path: '/repo/src/x.php', oldText: 'a', newText: 'b' }],
    };
    expect(translateSessionUpdate(u)[0]).toMatchObject({ msgType: 'fold_diff', label: 'Edit', subtitle: '/repo/src/x.php' });
  });

  it('uses ACP `locations[0].path` as subtitle when present (over the title)', () => {
    const u = {
      sessionUpdate: 'tool_call', toolCallId: 'e2', title: 'apply_patch', kind: 'edit', status: 'completed',
      locations: [{ path: '/repo/a.go' }],
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    } as unknown as SessionUpdate;
    expect(translateSessionUpdate(u)[0]).toMatchObject({ msgType: 'fold_code', label: 'Edit', subtitle: '/repo/a.go' });
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
      type: 'message', msgId: 't2', msgType: 'fold_code', label: 'Execute', subtitle: 'Run',
      body: { content: 'output line' },
    }]);
  });

  it('surfaces a failed tool_call as an error card', () => {
    const u: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Boom', status: 'failed' };
    const out = translateSessionUpdate(u);
    expect(out[0]).toMatchObject({ type: 'message', msgType: 'fold_code', errorMessage: 'Tool call failed' });
  });

  it('a COMPLETED tool with no output still carries an empty body (reload must not flag it "crashed")', () => {
    const u: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'View', kind: 'read', status: 'completed' };
    expect(translateSessionUpdate(u)).toEqual([{
      type: 'message', msgId: 'r1', msgType: 'fold_code', label: 'Read', subtitle: 'View', body: { content: '' },
    }]);
  });

  it('an IN-FLIGHT tool with no output stays body-less (so a genuine mid-call crash IS surfaced on reload)', () => {
    const u: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'r2', title: 'View', kind: 'read', status: 'in_progress' };
    expect(translateSessionUpdate(u)[0]).not.toHaveProperty('body');
  });

  it('captures a read result from rawOutput when the ACP content array is empty (copilot ships it there)', () => {
    const u = {
      sessionUpdate: 'tool_call_update', toolCallId: 'r3', status: 'completed',
      rawOutput: { content: '1. package main\n2. func x() {}' },
    } as unknown as SessionUpdate;
    expect(translateSessionUpdate(u)[0]).toMatchObject({
      type: 'message', msgType: 'fold_code', body: { content: '1. package main\n2. func x() {}' },
    });
  });

  it('captures a codex shell result from rawOutput.formatted_output', () => {
    const u = {
      sessionUpdate: 'tool_call_update', toolCallId: 'r4', status: 'completed',
      rawOutput: { formatted_output: 'exit 0\nok', exit_code: 0 },
    } as unknown as SessionUpdate;
    expect(translateSessionUpdate(u)[0]).toMatchObject({ body: { content: 'exit 0\nok' } });
  });

  it('renders copilot `task_complete` content as the turn\'s closing reply (its final summary), not a tool card', () => {
    const u = {
      sessionUpdate: 'tool_call_update', toolCallId: 'tc1', title: 'task_complete', status: 'completed',
      rawOutput: { content: '## Done\n- fixed the auto_renew override' },
    } as unknown as SessionUpdate;
    expect(translateSessionUpdate(u)).toEqual([
      { type: 'message', msgId: 'tc1', msgType: 'reply', content: '## Done\n- fixed the auto_renew override' },
    ]);
  });

  it('a bare `task_complete` signal with no content emits nothing', () => {
    const u: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'task_complete', status: 'pending' };
    expect(translateSessionUpdate(u)).toEqual([]);
  });

  it('ignores non-timeline updates (mode/commands)', () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'current_mode_update', currentModeId: 'agent' },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
    ];
    for (const u of updates) expect(translateSessionUpdate(u)).toEqual([]);
  });

  it('maps usage_update to a live context-usage status segment', () => {
    const out = translateSessionUpdate({ sessionUpdate: 'usage_update', used: 60, size: 100 } as SessionUpdate);
    expect(out).toEqual([
      { type: 'status', state: 'streaming', contextUsage: { text: 'ctx: 60%', severity: 'warning' } },
    ]);
  });
});

describe('createToolMetaCarry — title/kind survive partial tool_call_update', () => {
  it('carries the initial title + kind forward to a bare update (no clobber to defaults)', () => {
    const carry = createToolMetaCarry();
    const start: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Grep', kind: 'search' };
    // The result-bearing update (ACP partial: omits title AND kind) — must keep both.
    const finish: SessionUpdate = {
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'result' } }],
    };
    translateSessionUpdate(carry(start));
    // label = carried kind ('Search'), subtitle = carried title ('Grep') — not clobbered.
    expect(translateSessionUpdate(carry(finish))).toEqual([{
      type: 'message', msgId: 't1', msgType: 'fold_code', label: 'Search', subtitle: 'Grep',
      body: { content: 'result' },
    }]);
  });

  it('a later update that provides a new title overrides the subtitle (kind carried)', () => {
    const carry = createToolMetaCarry();
    carry({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Old', kind: 'read' });
    const out = translateSessionUpdate(carry({ sessionUpdate: 'tool_call_update', toolCallId: 't2', title: 'New' }));
    // subtitle updates to 'New'; label keeps the carried kind ('Read').
    expect(out[0]).toMatchObject({ msgId: 't2', label: 'Read', subtitle: 'New' });
  });

  it('isolates state per toolCallId and passes non-tool updates through untouched', () => {
    const carry = createToolMetaCarry();
    carry({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'A', kind: 'read' });
    // Different id with nothing to carry → generic 'Tool' label, no subtitle.
    const out = translateSessionUpdate(carry({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed' }));
    expect(out[0]).toMatchObject({ msgId: 'b', label: 'Tool' });
    expect(out[0]).not.toHaveProperty('subtitle');
    const passthrough: SessionUpdate = { sessionUpdate: 'current_mode_update', currentModeId: 'agent' };
    expect(carry(passthrough)).toBe(passthrough);
  });

  it('evicts metadata after enriching a terminal update', () => {
    const carry = createToolMetaCarry();
    carry({ sessionUpdate: 'tool_call', toolCallId: 'done', title: 'Read file', kind: 'read' });

    expect(carry({
      sessionUpdate: 'tool_call_update', toolCallId: 'done', status: 'completed',
    })).toMatchObject({ title: 'Read file', kind: 'read', status: 'completed' });

    const afterTerminal = carry({ sessionUpdate: 'tool_call_update', toolCallId: 'done' });
    expect(afterTerminal).not.toHaveProperty('title');
    expect(afterTerminal).not.toHaveProperty('kind');
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
