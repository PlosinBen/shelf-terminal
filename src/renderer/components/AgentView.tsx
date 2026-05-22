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
  setActualModel,
  setActualEffort,
  setActualPermissionMode,
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
   * Apply a config edit (model / effort / permissionMode). Used by
   * status bar cycle, /model slash, and renderer-local picker.
   * Renderer-authoritative: persists intent into projectConfig +
   * optimistic `actual*` for immediate display. Backend learns on
   * the next AGENT_SEND payload (orchestrator diffs and calls
   * provider.setX). No setPrefs IPC.
   *
   * Validation deferred to SDK (Decision #55) — typos surface as
   * `error` events when the next send fails to apply.
   */
  const handleConfigEdit = useCallback((key: 'model' | 'effort' | 'permissionMode', value: string) => {
    if (key === 'model') {
      setActualModel(tabId, value);
      persistPref({ model: value });
    } else if (key === 'effort') {
      setActualEffort(tabId, value);
      persistPref({ effort: value });
    } else if (key === 'permissionMode') {
      setActualPermissionMode(tabId, value);
      persistPref({ permissionMode: value });
    }
  }, [tabId, persistPref]);

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
        onConfigEdit={handleConfigEdit}
      />
    </div>
  );
}
