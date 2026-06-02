import { useCallback, useEffect, useRef } from 'react';
import type { AgentProvider, AgentPrefs, Connection } from '@shared/types';
import { MessageList } from './agent/MessageList';
import { InputZone } from './agent/InputZone';
import { StatusBar } from './agent/StatusBar';
import { DecisionPanel } from './agent/DecisionPanel';
import { PlanPanel } from './agent/PlanPanel';
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
 * 2. **Config-edit bridge** — `handleConfigEdit` writes intent into
 *    projectConfig.agentPrefs (needs projectIndex; sub-components don't
 *    have it) and sets optimistic `actual*` in the store. Shared by
 *    InputZone's /model slash, DecisionPanel's local picker resolve,
 *    and StatusBar's cycle buttons.
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
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId, opts: { intent: savedPrefs } });
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
   * This is what makes the typing path (/model X falls through to
   * agent:send → provider slash → capabilities) eventually update
   * projectConfig — InputZone no longer calls handleConfigEdit for
   * with-args slashes.
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

  /**
   * Apply a config edit (model / effort / permissionMode). Used by the picker
   * (status-bar click / `/model` no-arg) for all three.
   *
   * Routes through the provider as a structured config-edit turn — the SAME
   * path a typed `/model X` takes — so the divider + capabilities come back
   * identically regardless of entry point (DECISION #63). No optimistic
   * `setActual*` / `persistPref` here: display updates when the provider's
   * capabilities event lands, and the capability-driven effect persists intent.
   * Keeping a renderer-local optimistic update would diverge from the typed
   * path's round-trip behaviour — the inconsistency we set out to remove.
   */
  const handleConfigEdit = useCallback((key: 'model' | 'effort' | 'permissionMode', value: string) => {
    emitAgent('agent:send', { tabId, text: '', configEdit: { key, value } });
  }, [tabId]);

  const handleRetryInit = useCallback(() => {
    setInitStatusStore(tabId, 'starting');
    emitAgent('agent:destroy', { tabId });
    setCapabilitiesStore(tabId, null);
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId, opts: { intent: savedPrefs } });
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
        cwd={cwd}
        visible={visible}
        onRetryInit={handleRetryInit}
      />
      <DecisionPanel tabId={tabId} onConfigEdit={handleConfigEdit} />
      <PlanPanel tabId={tabId} />
      <InputZone
        tabId={tabId}
        projectId={projectId}
        cwd={cwd}
        connection={connection}
        visible={visible}
        rootRef={rootRef}
        intent={savedPrefs}
        onConfigEdit={handleConfigEdit}
      />
      <StatusBar
        tabId={tabId}
        provider={provider}
      />
    </div>
  );
}
