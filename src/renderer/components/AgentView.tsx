import { useCallback, useEffect, useRef } from 'react';
import type { AgentProvider, AgentPrefs, Connection } from '@shared/types';
import { MessageList } from './agent/MessageList';
import { InputZone } from './agent/InputZone';
import { StatusBar } from './agent/StatusBar';
import { DecisionPanel } from './agent/DecisionPanel';
import { PlanPanel } from './agent/PlanPanel';
import { BackgroundTasksPanel } from './agent/BackgroundTasksPanel';
import { AuthPane } from './agent/AuthPane';
import {
  initTab as initTabStore,
  removeTab as removeTabStore,
  setCapabilities as setCapabilitiesStore,
  setInitStatus as setInitStatusStore,
  useAgentTab,
} from '../agentTabStore';
import { emitAgent } from '../events';
import { useStore, updateProjectConfig } from '../store';

interface Props {
  tabId: string;
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
 * 1. **Per-tab lifecycle** — sessionId allocation (lazy create +
 *    persist into projectConfig), initTab/removeTab, emit init/destroy.
 * 2. **Capability-driven persist** — when the provider reports
 *    capabilities (after any config-edit turn), commit the backend's
 *    current* into projectConfig.agentPrefs (needs projectIndex;
 *    sub-components don't have it). The config-edit *action* itself is
 *    emitted directly by DecisionPanel (agent:send + configEdit), not
 *    routed through here.
 * 3. **Retry-init** — full re-arm sequence (setInitStatus + emit
 *    destroy + clear capabilities + emit init). Used by MessageList's
 *    failed-init UI.
 *
 * Everything else lives in the sub-components subscribing to
 * `useAgentTab(tabId)` directly. AuthPane gates the entire chat UI
 * when authRequired is set — early return mirrors the pre-refactor
 * branch so paste / scroll targets don't activate before sign-in.
 */
export function AgentView({ tabId, cwd, connection, provider, projectId, visible }: Props) {
  const { projects } = useStore();
  // Derive index from stable id every render — projectIndex (array
  // position) shifts when user reorders projects via drag, which
  // would otherwise point this AgentView at the wrong project's
  // prefs / sessionIds. See GOTCHAS "AgentView projectIndex drift".
  const projectIndex = projects.findIndex((p) => p.config.id === projectId);
  const savedPrefs = projects[projectIndex]?.config.agentPrefs?.[provider];

  const sessionIdRef = useRef<string | null>(null);
  if (!sessionIdRef.current) {
    const existing = projects[projectIndex]?.config.agentSessionIds?.[provider];
    if (existing) {
      sessionIdRef.current = existing;
    } else {
      const newId = crypto.randomUUID();
      sessionIdRef.current = newId;
      const ids = { ...projects[projectIndex]?.config.agentSessionIds, [provider]: newId };
      updateProjectConfig(projectIndex, { agentSessionIds: ids });
    }
  }
  const sessionId = sessionIdRef.current;

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
    return () => { removeTabStore(tabId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const persistPref = useCallback((partial: Partial<AgentPrefs>) => {
    const current = projects[projectIndex]?.config.agentPrefs ?? {};
    const updated = { ...current, [provider]: { ...current[provider], ...partial } };
    updateProjectConfig(projectIndex, { agentPrefs: updated });
  }, [projectIndex, provider, projects]);

  /**
   * Capability-driven persist: when provider re-broadcasts capabilities
   * (after /model X slash, picker pick, or any setX), commit the backend's
   * reported current* to projectConfig if it differs from what's saved.
   *
   * Init is naturally a no-op — provider seeds its closures from the intent
   * we passed in agent:init, so the first capabilities event carries back
   * exactly what savedPrefs already has. Only real changes (slash, cycle)
   * cause persist to fire.
   *
   * This is what makes the config-edit path (/model X or the picker →
   * agent:send → provider slash → capabilities) eventually update
   * projectConfig — there is no renderer-side optimistic config write;
   * persist follows the backend's capabilities event.
   */
  const capabilities = tabState?.capabilities;
  useEffect(() => {
    if (!capabilities) return;
    const partial: Partial<AgentPrefs> = {};
    if (capabilities.currentModel && capabilities.currentModel !== savedPrefs?.model) {
      partial.model = capabilities.currentModel;
    }
    if (capabilities.currentEffort && capabilities.currentEffort !== savedPrefs?.effort) {
      partial.effort = capabilities.currentEffort;
    }
    if (capabilities.currentPermissionMode && capabilities.currentPermissionMode !== savedPrefs?.permissionMode) {
      partial.permissionMode = capabilities.currentPermissionMode;
    }
    if (Object.keys(partial).length > 0) persistPref(partial);
  }, [capabilities?.currentModel, capabilities?.currentEffort, capabilities?.currentPermissionMode, savedPrefs?.model, savedPrefs?.effort, savedPrefs?.permissionMode, persistPref]);

  const handleRetryInit = useCallback(() => {
    setInitStatusStore(tabId, 'starting');
    emitAgent('agent:destroy', { tabId });
    setCapabilitiesStore(tabId, null);
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId, opts: { intent: savedPrefs, projectId } });
  }, [tabId, cwd, connection, provider, sessionId, savedPrefs]);

  if (authRequired) {
    return (
      <div className="agent-view" ref={rootRef}>
        <AuthPane tabId={tabId} />
      </div>
    );
  }

  return (
    <div className="agent-view" ref={rootRef}>
      <MessageList
        tabId={tabId}
        visible={visible}
        onRetryInit={handleRetryInit}
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
        intent={savedPrefs}
      />
      <StatusBar
        tabId={tabId}
        provider={provider}
      />
    </div>
  );
}
