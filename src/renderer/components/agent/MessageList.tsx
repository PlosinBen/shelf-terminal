import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentMessage } from '../AgentMessage';
import { buildTurns, cancelQueuedMessage, useAgentTab } from '../../agentTabStore';
import { useStore } from '../../store';
import { onAgent } from '../../events';

interface Props {
  tabId: string;
  cwd: string;
  visible: boolean;
  onRetryInit: () => void;
}

/**
 * Read-mostly view of an agent tab's timeline. Subscribes to the per-
 * tab store slice (messages / isStreaming / queuedMessages /
 * initStatus), owns its scroll-position intent (followBottomRef +
 * showJumpFab), and listens on the bus for cross-component "scroll
 * to bottom" nudges (sent by InputZone after submit; see DECISIONS #59).
 *
 * Why a separate component: AgentView used to own messages state +
 * input state + status state all in one place — any keystroke in the
 * input re-rendered the entire timeline. Splitting along subscription
 * boundary means MessageList only commits when its slice changes,
 * not on input keystrokes.
 */
export function MessageList({ tabId, cwd, visible, onRetryInit }: Props) {
  const tab = useAgentTab(tabId);
  const { settings } = useStore();

  const messages = tab?.messages ?? [];
  const isStreaming = tab?.isStreaming ?? false;
  const queuedMessages = tab?.queuedMessages ?? [];
  const initStatus = tab?.initStatus ?? 'starting';
  const initError = tab?.initError ?? null;

  const turns = useMemo(() => buildTurns(messages), [messages]);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // User intent to "stick to the bottom". Updated only by user-driven
  // scroll inputs (wheel/touch/keyboard); programmatic scrolls (auto
  // follow / FAB / bus nudge) deliberately do NOT touch it — they
  // honour intent, not geometric position. See AgentView pre-refactor
  // comment for the historical rationale (race-prone smooth-scroll
  // mid-animation if geometry-driven).
  //
  // Ref is source of truth (read by effects without re-render); FAB
  // visibility mirrors it as state.
  const followBottomRef = useRef(true);
  const [showJumpFab, setShowJumpFab] = useState(false);
  const setFollow = useCallback((follow: boolean) => {
    followBottomRef.current = follow;
    setShowJumpFab((prev) => (prev === !follow ? prev : !follow));
  }, []);

  // Cross-component bus nudge: send / queue-flush want to force snap
  // to bottom regardless of current scroll geometry.
  useEffect(() => {
    return onAgent('agent:scrollToBottom', ({ tabId: id }) => {
      if (id !== tabId) return;
      setFollow(true);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [tabId, setFollow]);

  // Track user-driven scroll inputs.
  // - UP is unambiguously "stop following" → set false synchronously
  //   so the next auto-follow effect's scrollIntoView never fires.
  // - DOWN is "catch up if I'm there" → geometry check in rAF (scrollTop
  //   hasn't settled inside the handler).
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
      // Finger DOWN drags content down → reveals earlier history →
      // user is scrolling UP. Inverse for finger UP.
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

  // Auto-follow new content. Reads intent only — programmatic scrolls
  // here do not touch followBottomRef.
  useEffect(() => {
    if (followBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    // Deps cover every visible-content trigger:
    // - messages: new bubble / streaming chunk / tool result upsert
    // - isStreaming: spinner flip
    // - queuedMessages: queued chip below the timeline
  }, [messages, isStreaming, queuedMessages]);

  // When tab becomes visible again, scrollIntoView is a no-op on
  // hidden elements — auto-follow couldn't run while display:none.
  // Catch up here so user sees the latest content, not stale middle.
  useEffect(() => {
    if (!visible) return;
    if (!followBottomRef.current) return;
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [visible]);

  const thinkingDisplay = settings.agentDisplay?.thinking ?? 'collapsed';
  const hasVisibleStreaming = messages.some((m) => {
    if (m.type === 'text' && m.streaming) return true;
    if (m.type === 'thinking' && m.streaming && thinkingDisplay !== 'hidden') return true;
    return false;
  });
  // Spinner shows during the gap between turn-start and first visible
  // chunk. Once chunks arrive, AgentMessage renders its own cursor on
  // `streaming: true` entries, so the spinner becomes redundant.
  const showSpinner = isStreaming && !hasVisibleStreaming && messages.length > 0;

  return (
    <div className="agent-messages" ref={listRef}>
      {initStatus === 'starting' && messages.length === 0 && (
        <div className="agent-init-pane">
          <span className="agent-loading-spinner" />
          <span className="agent-loading-text">Starting agent…</span>
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
        // Streaming content lives in messages as entries with
        // `streaming: true` — AgentMessage renders the cursor inline.
        const hasResponseContent = turn.agent.length > 0;
        return (
          <div key={turn.user?.id ?? `turn-${ti}`} className="agent-turn">
            {turn.user && <AgentMessage message={turn.user} cwd={cwd} />}
            {hasResponseContent && (
              <div className="agent-turn-response">
                {turn.agent.map((msg) => <AgentMessage key={msg.id} message={msg} cwd={cwd} />)}
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

      {queuedMessages.map((q) => (
        <div key={q.id} className="agent-msg agent-msg-user agent-msg-queued">
          <div className="agent-msg-content">{q.content}</div>
          <span className="agent-queued-label">queued</span>
          <button
            className="agent-queued-cancel"
            onClick={() => cancelQueuedMessage(tabId, q.id)}
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
  );
}
