import { describe, it, expect } from 'vitest';
import { nextForceFollow } from './scroll-follow';
import type { AgentMsg } from '../AgentMessage';

const user = (id: string): AgentMsg =>
  ({ id, type: 'user', content: 'hi', timestamp: 0 } as AgentMsg);
const agent = (id: string): AgentMsg =>
  ({ id, type: 'reply', content: 'ok', provider: 'claude', timestamp: 0 } as AgentMsg);

describe('nextForceFollow', () => {
  it('no messages → never forces', () => {
    expect(nextForceFollow(null, [])).toEqual({ tailUserId: null, force: false });
  });

  it('a new user message at the tail forces follow and is remembered', () => {
    expect(nextForceFollow(null, [user('u1')])).toEqual({ tailUserId: 'u1', force: true });
  });

  it('the same tail user id does not re-trigger (idempotent re-render)', () => {
    expect(nextForceFollow('u1', [user('u1')])).toEqual({ tailUserId: 'u1', force: false });
  });

  it('an agent reply after the user bubble does not force, and keeps the remembered id', () => {
    expect(nextForceFollow('u1', [user('u1'), agent('a1')])).toEqual({
      tailUserId: 'u1',
      force: false,
    });
  });

  it('a fresh user send after agent replies forces again', () => {
    expect(nextForceFollow('u1', [user('u1'), agent('a1'), user('u2')])).toEqual({
      tailUserId: 'u2',
      force: true,
    });
  });

  it('streaming agent chunks never force-follow (respects scroll-up)', () => {
    expect(nextForceFollow(null, [agent('a1')])).toEqual({ tailUserId: null, force: false });
  });
});
