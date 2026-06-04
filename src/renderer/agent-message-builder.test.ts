import { describe, it, expect } from 'vitest';
import { buildAgentMsg } from './agent-message-builder';

describe('buildAgentMsg', () => {
  it('maps reply wire payload to a reply bubble', () => {
    const out = buildAgentMsg({ type: 'reply', msgId: 'm1', content: 'hi' }, 'claude');
    expect(out).toMatchObject({ id: 'm1', type: 'reply', content: 'hi', provider: 'claude' });
  });

  it('maps error wire payload to an error bubble', () => {
    const out = buildAgentMsg({ type: 'error', msgId: 'e1', content: 'boom' }, 'claude');
    expect(out).toMatchObject({ id: 'e1', type: 'error', content: 'boom' });
  });

  it('returns null for unknown message type', () => {
    const out = buildAgentMsg({ type: 'totally-unknown', msgId: 'x' } as any, 'claude');
    expect(out).toBeNull();
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
        'claude',
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
        'claude',
      ) as any;
      expect(out.images).toEqual(['data:image/png;base64,x']);
    });

    it('omits images/files when empty or absent', () => {
      const out = buildAgentMsg({ type: 'user', msgId: 'u2', content: 'plain' }, 'claude') as any;
      expect(out.images).toBeUndefined();
      expect(out.files).toBeUndefined();
    });

    it('falls back to empty string when content is missing', () => {
      const out = buildAgentMsg({ type: 'user', msgId: 'u3' }, 'claude') as any;
      expect(out.content).toBe('');
    });
  });
});
