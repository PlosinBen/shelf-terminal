import React from 'react';
import { useAgentTab } from '../../agentTabStore';
import { useStore } from '../../store';
import { initPhaseLabel } from './init-phase';

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
 * Covers the pane for every not-ready state, unified into one surface:
 *  - initStatus 'starting'        → spinner + phase text (first-open init, OR a
 *    (re)connect in flight). Prominent cover, NOT a subtle in-list hint, so the
 *    pane clearly reads "not ready yet" and the input is visibly blocked.
 *  - initStatus 'failed'          → "Failed to start agent" + Retry
 *  - connection health 'dead'     → "Connection lost" + Reconnect
 *    (heartbeat lost — e.g. the dispatcher/host went down)
 * Clears itself once init is ready AND health recovers — a reconnect seeds
 * 'healthy' (see dispatcher-connection), so no stale overlay lingers.
 */
export function ConnectionOverlay({ tabId, onRetry }: Props) {
  const tab = useAgentTab(tabId);
  const { connectionHealth } = useStore();
  const initStatus = tab?.initStatus ?? 'starting';
  const dead = connectionHealth[tabId]?.state === 'dead';
  const failed = initStatus === 'failed';
  const starting = initStatus === 'starting';

  // Cover the pane whenever it isn't usable: starting (init / reconnect),
  // failed, or connection dead. Only a ready + healthy pane shows no overlay.
  if (!starting && !failed && !dead) return null;

  return (
    <div className="agent-conn-overlay" role="alert">
      <div className="agent-conn-card">
        {starting ? (
          <>
            <span className="agent-loading-spinner" />
            {/* dead+starting = a reconnect in flight; otherwise first-open init. */}
            <div className="agent-conn-title">{dead ? 'Reconnecting…' : initPhaseLabel(tab?.initPhase ?? null)}</div>
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
