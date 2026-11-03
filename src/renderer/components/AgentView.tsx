import { useCallback, useEffect, useRef } from 'react';
import type { AgentProvider, Connection } from '@shared/types';
import { PROJECT_MUTATION } from '@shared/project-mutations';
import { MessageList } from './agent/MessageList';
import { InputZone } from './agent/InputZone';
import { StatusBar } from './agent/StatusBar';
import { DecisionPanel } from './agent/DecisionPanel';
import { PlanPanel } from './agent/PlanPanel';
import { BackgroundTasksPanel } from './agent/BackgroundTasksPanel';
import { ConnectionOverlay } from './agent/ConnectionOverlay';
import { AuthPane } from './agent/AuthPane';
import { ShelfMcpBanner } from './agent/ShelfMcpBanner';
import {
  initTab as initTabStore,
  useAgentTab,
} from '../agentTabStore';
import { emitAgent, emit, Events } from '../events';
import { useStore } from '../store';

interface Props {
  tabId: string;
  sessionId: string;
  cwd: string;
  connection: Connection;
  provider: AgentProvider;
  projectId: string;
  visible: boolean;
}

/**
 * Layout coordinator for an agent tab. Holds three concerns the
 * sub-components can't reasonably own:
 *
 * 1. **Per-tab lifecycle** — mount the main-issued stable session binding from
 *    canonical Project.agentViews, initTab, and emit init.
 *    Store removal belongs to actual tab teardown, not React component unmount.
 * 2. **Capability-driven persist** — when the provider reports
 *    capabilities (after any config-edit turn), commit the backend's
 *    current* into canonical `Project.agentViews[sessionId].prefs` (needs projectId;
 *    sub-components don't have it). The config-edit *action* itself is
 *    emitted directly by DecisionPanel (agent:send + configEdit), not
 *    routed through here.
 * 3. **Retry-init intent** — delegated to App so retries read durable prefs
 *    before restarting the same session.
 *
 * Everything else lives in the sub-components subscribing to
 * `useAgentTab(tabId)` directly. AuthPane gates the entire chat UI
 * when authRequired is set — early return mirrors the pre-refactor
 * branch so paste / scroll targets don't activate before sign-in.
 */
export function AgentView({ tabId, sessionId, cwd, connection, provider, projectId, visible }: Props) {
  const { projects } = useStore();
  // Derive index from stable id every render — projectIndex (array
  // position) shifts when user reorders projects via drag, which
  // would otherwise point this AgentView at the wrong project's
  // prefs / sessionIds. See GOTCHAS "AgentView projectIndex drift".
  const projectIndex = projects.findIndex((p) => p.id === projectId);
  const savedPrefs = projects[projectIndex]?.agentViews[sessionId]?.prefs;

  // Only read what AgentView still needs directly: authRequired
  // gates the early return. Everything else (messages / status /
  // decisions / plan) is read inside the relevant sub-component.
  const tabState = useAgentTab(tabId);
  const authRequired = tabState?.authRequired ?? null;

  // rootRef is the paste/drop target — InputZone's useAttachmentPaste
  // attaches to it so paste anywhere inside the agent area is
  // captured, not just inside the textarea.
  const rootRef = useRef<HTMLDivElement>(null);

  // Per-tab lifecycle. initTab is idempotent + keyed on tabId; the
  // dependency list intentionally only includes tabId because cwd /
  // connection / provider / sessionId never change for a mounted
  // AgentView (they come from the tab's identity).
  useEffect(() => {
    initTabStore(tabId, { sessionId, provider, intent: savedPrefs });
    // `opts.intent` flows main-side through AGENT_INIT → getCapabilities so
    // session-stateful providers (Copilot) can seed their closures BEFORE
    // emitting the first capabilities event. Without this, copilot's
    // `currentPermissionMode` reports its hardcoded 'default' on every
    // reconnect, overwriting the warm-started actual* in agentTabStore.
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId, opts: { intent: savedPrefs, projectId } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  /**
   * Capability-driven persist: when provider re-broadcasts capabilities
   * (after /model X slash, picker pick, or any setX), commit the backend's
   * reported current* to canonical `Project.agentViews[sessionId].prefs` if it differs from
   * what's saved.
   *
   * Forward each report once; main compares against latest saved prefs inside
   * its mutation queue. Comparing here can drop an A→B→A change while B is pending.
   * Unchanged reports and unconfirmed native defaults are durable no-ops.
   *
   * This is what makes the config-edit path (/model X or the picker →
   * agent:send → provider slash → capabilities) eventually update canonical
   * `Project.agentViews[sessionId].prefs` through the project mutation boundary — there is no
   * renderer-side optimistic write; persist follows the backend's capabilities
   * event.
   */
  const capabilities = tabState?.capabilities;
  // A prefs mutation must not replay an older provider snapshot (e.g. when
  // clearing an unavailable model). Persist each newly reported snapshot once.
  const persistedCapabilities = useRef<typeof capabilities>(undefined);
  useEffect(() => {
    if (!capabilities || capabilities === persistedCapabilities.current) return;
    persistedCapabilities.current = capabilities;
    const { confirmedPrefs, permissionControl, currentModel, currentEffort, currentPermissionMode } = capabilities;
    emit(Events.UPDATE_PROJECT, projectId, {
      kind: PROJECT_MUTATION.AGENT_REPORT, sessionId,
      report: { confirmedPrefs, permissionControl, currentModel, currentEffort, currentPermissionMode },
    });
  }, [capabilities, projectId, sessionId]);

  const handleRetryInit = useCallback(() => {
    emitAgent('agent:retryInit', { tabId });
  }, [tabId]);

  if (authRequired) {
    return (
      <div className="agent-view" ref={rootRef}>
        <ShelfMcpBanner tabId={tabId} />
        <AuthPane tabId={tabId} />
      </div>
    );
  }

  return (
    <div className="agent-view" ref={rootRef}>
      <ShelfMcpBanner tabId={tabId} />
      <MessageList
        tabId={tabId}
        visible={visible}
      />
      <DecisionPanel tabId={tabId} />
      <PlanPanel tabId={tabId} />
      <BackgroundTasksPanel tabId={tabId} />
      <InputZone
        tabId={tabId}
        projectId={projectId}
        cwd={cwd}
        connection={connection}
        visible={visible}
        rootRef={rootRef}
      />
      <StatusBar
        tabId={tabId}
        provider={provider}
      />
      <ConnectionOverlay tabId={tabId} onRetry={handleRetryInit} />
    </div>
  );
}
