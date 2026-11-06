import { describe, it, expect, vi } from 'vitest';
import { CLAUDE_PROVIDER } from '@shared/agent-providers';
import { buildAgentMsg } from './agent-message-builder';
import type { AgentMsg } from './components/AgentMessage';
import { AGENT_INPUT_SOURCE, AGENT_REPLY_REQUIREMENT, createAgentInputMessage } from '@shared/agent-input';

describe('buildAgentMsg', () => {
  it('preserves mirrored Telegram original text and canonical metadata without changing old history', () => {
    const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.TELEGRAM }, content: 'original', replyRequirement: AGENT_REPLY_REQUIREMENT.BRIEF_PLAIN_TEXT });
    if (!built.ok) throw new Error(built.error);
    expect(buildAgentMsg({ type: 'user', msgId: built.message.msgId, content: 'original', inputMessage: built.message }, CLAUDE_PROVIDER)).toMatchObject({ content: 'original', inputMessage: built.message });
    expect(buildAgentMsg({ type: 'user', msgId: 'legacy', content: 'old' }, CLAUDE_PROVIDER)).toMatchObject({ id: 'legacy', content: 'old' });
  });
  it('maps reply wire payload to a reply bubble', () => {
    const out = buildAgentMsg({ type: 'reply', msgId: 'm1', content: 'hi' }, CLAUDE_PROVIDER);
    expect(out).toMatchObject({ id: 'm1', type: 'reply', content: 'hi', provider: CLAUDE_PROVIDER });
  });

  it('maps error wire payload to an error bubble', () => {
    const out = buildAgentMsg({ type: 'error', msgId: 'e1', content: 'boom' }, CLAUDE_PROVIDER);
    expect(out).toMatchObject({ id: 'e1', type: 'error', content: 'boom' });
  });

  it('returns null for unknown message type', () => {
    const out = buildAgentMsg({ type: 'totally-unknown', msgId: 'x' } as any, CLAUDE_PROVIDER);
    expect(out).toBeNull();
  });

  it('carries parentToolUseId through for a nested subagent message', () => {
    const out = buildAgentMsg({ type: 'fold_code', msgId: 't1', label: 'Read', parentToolUseId: 'outer-1' }, CLAUDE_PROVIDER) as any;
    expect(out.parentToolUseId).toBe('outer-1');
  });

  it('omits parentToolUseId for a top-level message', () => {
    const out = buildAgentMsg({ type: 'reply', msgId: 'm1', content: 'hi' }, CLAUDE_PROVIDER) as any;
    expect(out.parentToolUseId).toBeUndefined();
  });

  it('does not carry wire turn markers into renderer messages', () => {
    const out = buildAgentMsg(
      { type: 'reply', msgId: 'm1', content: 'auto-resume', startsTurn: true },
      CLAUDE_PROVIDER,
    ) as AgentMsg & { startsTurn?: boolean };
    expect(out.startsTurn).toBeUndefined();
  });

  /**
   * Regression: Telegram bridge → agent view used to silently swallow the
   * user's message (the renderer's history showed only the agent reply, not
   * the question that was asked). Fix mirrors the prompt as a wire-emitted
   * `{type:'user',...}` AgentMessage so buildAgentMsg must turn it into a
   * user bubble — without this case, the upsert in agentTabSubscriptions
   * gets null and drops the message.
   */
  describe('user variant (bridge mirror regression)', () => {
    it('maps user wire payload to a user bubble', () => {
      const out = buildAgentMsg(
        { type: 'user', msgId: 'bridge-user-1', content: 'hello from telegram' },
        CLAUDE_PROVIDER,
      );
      expect(out).toMatchObject({
        id: 'bridge-user-1',
        type: 'user',
        content: 'hello from telegram',
      });
    });

    it('passes through images when present', () => {
      const out = buildAgentMsg(
        { type: 'user', msgId: 'u1', content: 'pic', images: ['data:image/png;base64,x'] },
        CLAUDE_PROVIDER,
      ) as any;
      expect(out.images).toEqual(['data:image/png;base64,x']);
    });

    it('omits images/files when empty or absent', () => {
      const out = buildAgentMsg({ type: 'user', msgId: 'u2', content: 'plain' }, CLAUDE_PROVIDER) as any;
      expect(out.images).toBeUndefined();
      expect(out.files).toBeUndefined();
    });

    it('falls back to empty string when content is missing', () => {
      const out = buildAgentMsg({ type: 'user', msgId: 'u3' }, CLAUDE_PROVIDER) as any;
      expect(out.content).toBe('');
    });
  });
});

describe('File Diff renderer projection', () => {
  it('retains all hunks and legacy string bodies', () => {
    for (const diff of [
      { hunks: [
        { oldStart: 2, newStart: 2, oldLines: ['a'], newLines: ['b', 'c'] },
        { oldStart: 10, newStart: 11, oldLines: ['x'], newLines: ['y'] },
      ] },
      { oldString: 'old\n', newString: 'new\n' },
    ]) {
      expect(buildAgentMsg({ type: 'fold_diff', msgId: 'edit', label: 'Edit', body: { diff } }, CLAUDE_PROVIDER))
        .toMatchObject({ type: 'fold_diff', body: { diff } });
    }
  });
  it('fails visibly on malformed data without losing the upstream error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = buildAgentMsg({ type: 'fold_diff', msgId: 'bad', label: 'Edit', errorMessage: 'File change failed', body: { diff: { hunks: [] } } }, CLAUDE_PROVIDER);
      expect(out).toMatchObject({ errorMessage: 'File change failed; Invalid file diff data' });
      expect(out).not.toHaveProperty('body');
      expect(warn).toHaveBeenCalledWith('Invalid diff body', expect.objectContaining({ msgId: 'bad' }));
    } finally { warn.mockRestore(); }
  });
});
