import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentMessage } from '../AgentMessage';
import { AgentDisplayContext } from './AgentDisplayContext';
import { buildTurns, cancelPendingSend, useAgentTab } from '../../agentTabStore';
import { emitAgent } from '../../events';
import { useStore } from '../../store';
import { nextForceFollow } from './scroll-follow';

interface Props {
  tabId: string;
  visible: boolean;
  onRetryInit: () => void;
}

/**
 * Complete, self-contained agent message-history component.
 *
 * Subscribes to its own per-tab store slice (messages / isStreaming /
 * pendingSends / initStatus) so input keystrokes elsewhere don't re-render
 * the timeline (agent-ui#4), owns its scroll-position intent, and renders
 * the entire message area: init/empty/failed pane, the turn timeline, the
 * streaming spinner, queued-message chips, and the jump-to-bottom FAB.
 *
 * Display prefs flow to `AgentMessage` children via `AgentDisplayContext`
 * (the list owns the config; messages don't reach into the global store).
 */
export function MessageList({ tabId, visible, onRetryInit }: Props) {
  const tab = useAgentTab(tabId);
  const { settings } = useStore();

  const messages = tab?.messages ?? [];
  const isStreaming = tab?.isStreaming ?? false;
  const pendingSends = tab?.pendingSends ?? [];
  const initStatus = tab?.initStatus ?? 'starting';
  const initPhase = tab?.initPhase ?? null;
  const initError = tab?.initError ?? null;
  const agentDisplay = settings.agentDisplay ?? {};
  const startingText =
    initPhase === 'deploying' ? 'Deploying runtime…' :
    initPhase === 'connecting' ? 'Connecting…' :
    initPhase === 'checking-auth' ? 'Checking sign-in…' :
    'Starting agent…';

  const turns = useMemo(() => buildTurns(messages), [messages]);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // User intent to "stick to the bottom". Updated only by user-driven scroll
  // inputs; programmatic scrolls honour intent, not geometry. Ref is source of
  // truth (read by effects without re-render); FAB visibility mirrors it.
  const followBottomRef = useRef(true);
  const [showJumpFab, setShowJumpFab] = useState(false);
  const setFollow = useCallback((follow: boolean) => {
    followBottomRef.current = follow;
    setShowJumpFab((prev) => (prev === !follow ? prev : !follow));
  }, []);

  // A locally-sent (or bridge-mirrored) prompt appends a user message at the
  // tail → re-engage bottom-follow even if the user had scrolled up. Derived
  // from our own slice (replaces the old agent:scrollToBottom bus nudge); the
  // actual scroll is done by the auto-follow effect below once it re-renders.
  const tailUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const { tailUserId, force } = nextForceFollow(tailUserIdRef.current, messages);
    tailUserIdRef.current = tailUserId;
    if (force) setFollow(true);
  }, [messages, setFollow]);

  // Track user-driven scroll inputs (UP = stop following; DOWN = catch up if
  // already at bottom, checked in rAF since scrollTop hasn't settled).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const isAtBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    const recomputeFromGeometry = () => {
      requestAnimationFrame(() => setFollow(isAtBottom()));
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setFollow(false);
      else if (e.deltaY > 0) recomputeFromGeometry();
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const dy = (e.touches[0]?.clientY ?? 0) - touchStartY;
      if (dy > 4) setFollow(false);
      else if (dy < -4) recomputeFromGeometry();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) setFollow(false);
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(e.key)) recomputeFromGeometry();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKey);
    };
  }, [setFollow]);

  // Auto-follow new content. Reads intent only.
  useEffect(() => {
    if (followBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    // Deps: messages (new bubble / chunk / upsert), isStreaming (spinner flip),
    // pendingSends (queued chip below the timeline).
  }, [messages, isStreaming, pendingSends]);

  // When tab becomes visible again, catch up (scrollIntoView is a no-op while
  // display:none, so auto-follow couldn't run).
  useEffect(() => {
    if (!visible) return;
    if (!followBottomRef.current) return;
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [visible]);

  const hasVisibleStreaming = messages.some((m) => {
    if (m.type === 'reply' && m.streaming) return true;
    if (m.type === 'fold_text' && m.streaming) return true;
    return false;
  });
  // Spinner shows during the gap between turn-start and first visible chunk.
  // "Busy" includes a non-empty queue so the spinner stays up across the brief
  // inter-turn idle while the server drains queued sends (no flicker).
  const busy = isStreaming || pendingSends.length > 0;
  const showSpinner = busy && !hasVisibleStreaming && messages.length > 0;

  return (
    <AgentDisplayContext.Provider value={agentDisplay}>
      <div className="agent-messages" ref={listRef}>
        {initStatus === 'starting' && messages.length === 0 && (
          <div className="agent-init-pane">
            <span className="agent-loading-spinner" />
            <span className="agent-loading-text">{startingText}</span>
          </div>
        )}
        {initStatus === 'failed' && (
          <div className="agent-init-pane agent-init-failed">
            <div className="agent-init-failed-title">Failed to start agent</div>
            {initError && <div className="agent-init-failed-reason">{initError}</div>}
            <button className="conn-btn conn-btn-next" onClick={onRetryInit}>Retry</button>
          </div>
        )}
        {initStatus === 'ready' && messages.length === 0 && !isStreaming && (
          <div className="agent-empty">Send a message to start</div>
        )}

        {turns.map((turn, ti) => {
          const hasResponseContent = turn.agent.length > 0;
          return (
            <div key={turn.user?.id ?? `turn-${ti}`} className="agent-turn">
              {turn.user && <AgentMessage message={turn.user} />}
              {hasResponseContent && (
                <div className="agent-turn-response">
                  {turn.agent.map((msg) => (
                    <AgentMessage key={msg.id} message={msg} nested={turn.children[msg.id]} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {showSpinner && (
          <div className="agent-loading">
            <span className="agent-loading-spinner" />
            <span className="agent-loading-text">Agent is running... (Esc to stop)</span>
          </div>
        )}

        {pendingSends.map((p) => (
          <div key={p.clientMsgId} className="agent-msg agent-msg-user agent-msg-queued">
            <div className="agent-msg-content">{p.content}</div>
            <span className="agent-queued-label">queued</span>
            <button
              className="agent-queued-cancel"
              onClick={() => {
                // Optimistic local removal + fire the IPC cancel. If it raced to
                // 'running', the next snapshot re-promotes it (reconcile).
                cancelPendingSend(tabId, p.clientMsgId);
                emitAgent('agent:cancelQueued', { tabId, clientMsgId: p.clientMsgId });
              }}
              title="Cancel"
            >×</button>
          </div>
        ))}

        <div ref={bottomRef} />

        {showJumpFab && (
          <button
            className="agent-jump-fab"
            onClick={() => {
              setFollow(true);
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
            title="Jump to latest"
            aria-label="Jump to latest"
          >
            ↓
          </button>
        )}
      </div>
    </AgentDisplayContext.Provider>
  );
}
