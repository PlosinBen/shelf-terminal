import type { AgentMsg } from '../AgentMessage';

/**
 * Decide whether the timeline should force-re-engage bottom-follow.
 *
 * A locally-sent (or Telegram-bridge-mirrored) prompt appends a `user` message
 * at the tail — that's the user acting in this view, so snap back to the bottom
 * even if they'd scrolled up to read history. Agent / stream messages must NOT
 * force-follow (respect a deliberate scroll-up while the agent runs).
 *
 * Derived purely from the message slice + the last id we already forced on, so
 * a re-render with the same tail doesn't re-trigger. Pure → unit-testable with
 * no DOM. Replaces the old cross-component `agent:scrollToBottom` bus nudge:
 * the scroll intent belongs to the timeline, so the timeline derives it itself.
 *
 * @param prevTailUserId the tail user-message id we last forced on (ref)
 * @param messages       the current message slice
 * @returns the tail user-message id to remember, and whether to force-follow now
 */
export function nextForceFollow(
  prevTailUserId: string | null,
  messages: AgentMsg[],
): { tailUserId: string | null; force: boolean } {
  const last = messages[messages.length - 1];
  const tailIsUser = !!last && last.type === 'user';
  // Keep the remembered id when the tail isn't a user message, so an agent
  // reply landing after the user bubble doesn't "reset" and let the same send
  // re-trigger later.
  const tailUserId = tailIsUser ? last.id : prevTailUserId;
  const force = tailIsUser && last.id !== prevTailUserId;
  return { tailUserId, force };
}
