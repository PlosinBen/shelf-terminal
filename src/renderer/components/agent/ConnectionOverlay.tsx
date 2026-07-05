import React from 'react';
import { useAgentTab } from '../../agentTabStore';
import { useStore } from '../../store';

interface Props {
  tabId: string;
  onRetry: () => void;
}

/**
 * Prominent recovery overlay for a broken agent pane. Covers the pane (dim +
 * blur so the conversation behind stays readable) with a centered card,
 * scoped to THIS pane via position:absolute inside `.agent-view` (never
 * `fixed` — that would cover the sidebar and any sibling split pane).
 *
 * Unifies the two failure sources into one clear recovery point:
 *  - initStatus 'failed'          → "Failed to start agent" + Retry
 *  - connection health 'dead'     → "Connection lost" + Reconnect
 *    (heartbeat lost — e.g. the dispatcher/host went down)
 * While a (re)connect is in flight (initStatus 'starting') it shows a spinner
 * so the pane never flashes blank. It clears itself once init is ready AND
 * health recovers — a reconnect seeds 'healthy' (see dispatcher-connection),
 * so no stale overlay lingers.
 */
export function ConnectionOverlay({ tabId, onRetry }: Props) {
  const tab = useAgentTab(tabId);
  const { connectionHealth } = useStore();
  const initStatus = tab?.initStatus ?? 'starting';
  const dead = connectionHealth[tabId]?.state === 'dead';
  const failed = initStatus === 'failed';
  const starting = initStatus === 'starting';

  // Only a genuinely broken pane gets the overlay. A first-open 'starting'
  // (neither dead nor failed) keeps the lightweight in-list spinner.
  if (!failed && !dead) return null;

  return (
    <div className="agent-conn-overlay" role="alert">
      <div className="agent-conn-card">
        {starting ? (
          <>
            <span className="agent-loading-spinner" />
            <div className="agent-conn-title">Reconnecting…</div>
          </>
        ) : failed ? (
          <>
            <div className="agent-conn-title">Failed to start agent</div>
            {tab?.initError && <div className="agent-conn-reason">{tab.initError}</div>}
            <button className="conn-btn conn-btn-next agent-conn-btn" onClick={onRetry}>Retry</button>
          </>
        ) : (
          <>
            <div className="agent-conn-title">Connection lost</div>
            <div className="agent-conn-reason">The connection to this agent dropped.</div>
            <button className="conn-btn conn-btn-next agent-conn-btn" onClick={onRetry}>Reconnect</button>
          </>
        )}
      </div>
    </div>
  );
}
