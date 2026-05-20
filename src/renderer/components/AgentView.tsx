import React, { useCallback, useEffect, useRef } from 'react';
import type { AgentProvider, AgentPrefs, Connection } from '@shared/types';
import { MessageList } from './agent/MessageList';
import { InputZone } from './agent/InputZone';
import { SelectionPanel } from './SelectionPanel';
import { PickerPanel } from './PickerPanel';
import {
  initTab as initTabStore,
  removeTab as removeTabStore,
  clearMessages as clearMessagesStore,
  setActualModel,
  setActualEffort,
  setActualPermissionMode,
  setAuthBusy,
  setAuthError,
  setAuthRequired,
  setCapabilities as setCapabilitiesStore,
  setInitStatus as setInitStatusStore,
  setLocalPicker as setLocalPickerStore,
  setPendingPermission as setPendingPermissionStore,
  setPendingPicker as setPendingPickerStore,
  useAgentTab,
} from '../agentTabStore';
import { emitAgent } from '../events';
import { useStore, updateProjectConfig } from '../store';

// Local-only types — store's Capabilities is the source of truth and
// tabState.capabilities carries it. SlashCommand is the shape of items
// shown in the slash autocomplete menu (subset of Capabilities['slashCommands']).
interface SlashCommand {
  name: string;
  description: string;
}

interface Props {
  tabId: string;
  cwd: string;
  connection: Connection;
  provider: AgentProvider;
  projectId: string;
  visible: boolean;
}

export function AgentView({ tabId, cwd, connection, provider, projectId, visible }: Props) {
  const { projects, settings, chatStage } = useStore();
  // Derive index from stable id every render — projectIndex (array position)
  // shifts when user reorders projects via drag, which would otherwise point
  // this AgentView at the wrong project's prefs / sessionIds. See
  // .agent/GOTCHAS.md "AgentView projectIndex drift on reorder".
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

  // Domain state lives in agentTabStore now. AgentView subscribes via
  // useAgentTab so only changes for THIS tab trigger a re-render
  // (unlike the global useStore which rebuilds snapshot on every
  // change). The slice is created synchronously by initTab in the
  // mount effect below; until that runs, `tabState` is undefined and
  // we fall back to safe defaults.
  const tabState = useAgentTab(tabId);
  // messages / initStatus / queuedMessages live in <MessageList>;
  // input-related state in <InputZone>. AgentView only reads what
  // its remaining UI surface needs: plan panel + status bar +
  // decision panels + auth pane.
  const currentPlan = tabState?.currentPlan ?? '';
  const isStreaming = tabState?.isStreaming ?? false;
  const statusModel = tabState?.actualModel ?? null;
  const costUsd = tabState?.costUsd;
  const numTurns = tabState?.numTurns;
  const contextUsage = tabState?.contextUsage ?? null;
  const rateLimits = tabState?.rateLimits ?? [];
  const capabilities = tabState?.capabilities ?? null;
  const permissionMode = tabState?.actualPermissionMode ?? 'default';
  const currentEffort = tabState?.actualEffort ?? 'medium';
  const pendingPermission = tabState?.pendingPermission ?? null;
  const pendingPicker = tabState?.pendingPicker ?? null;
  const localPicker = tabState?.localPicker ?? null;
  const authRequired = tabState?.authRequired ?? null;
  const authBusy = tabState?.authBusy ?? false;
  const authError = tabState?.authError ?? null;

  // Input value, slash menu, attachment chips, ESC twice — all moved
  // to <InputZone>. AgentView no longer touches input UI state.

  const persistPref = useCallback((partial: Partial<AgentPrefs>) => {
    const current = projects[projectIndex]?.config.agentPrefs ?? {};
    const updated = { ...current, [provider]: { ...current[provider], ...partial } };
    updateProjectConfig(projectIndex, { agentPrefs: updated });
  }, [projectIndex, provider, projects]);

  const rootRef = useRef<HTMLDivElement>(null);
  // listRef / bottomRef / scroll-follow state moved into <MessageList>;
  // inputRef / input state moved into <InputZone>. rootRef stays — it's
  // the paste/drop target passed into InputZone's useAttachmentPaste so
  // the whole agent area captures attachments, not just the textarea.

  // Per-tab lifecycle: initTab creates the slice (synchronously),
  // warm-starts actual* from savedPrefs (intent), and triggers async
  // IDB load. Backend events route through agentTabSubscriptions →
  // store actions; this component just emits the init request.
  // removeTab on unmount flushes any pending IDB save synchronously.
  useEffect(() => {
    initTabStore(tabId, {
      sessionId,
      provider,
      intent: savedPrefs,
    });
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId });
    return () => {
      removeTabStore(tabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const handleRetryInit = useCallback(async () => {
    setInitStatusStore(tabId, 'starting');
    emitAgent('agent:destroy', { tabId });
    setCapabilitiesStore(tabId, null);
    emitAgent('agent:init', { tabId, cwd, connection, provider, sessionId });
  }, [tabId, cwd, connection, provider, sessionId]);

  // Queued-message flush, handleSend, handleStop, chatStage consumer,
  // and all input-related state moved into <InputZone>. AgentView no
  // longer touches the input path at all.

  // Permission response. scope='session' tells provider to remember allow for the rest of the session.
  const handlePermissionRespond = useCallback((allow: boolean, scope?: 'once' | 'session') => {
    if (!pendingPermission) return;
    emitAgent('agent:resolvePermission', {
      tabId,
      toolUseId: pendingPermission.toolUseId,
      allow,
      scope,
    });
    setPendingPermissionStore(tabId, null);
  }, [tabId, pendingPermission]);

  // Permission / picker keyboard handling is owned by the <SelectionPanel>
  // component (internal cursor state + window keydown listener with priority
  // capture). AgentView only owns the "is panel open?" gates
  // (pendingPermission / pendingPicker) and the callbacks that act on the
  // selected value.

  /**
   * Apply a config edit (model / effort / permissionMode change). Used by
   * status bar cycle, `/model X` slash, and renderer-local picker resolve.
   * Renderer is the source of truth for prefs — savedPrefs in projectConfig
   * + local status state. Backend learns on the next AGENT_SEND payload
   * (orchestrator diffs and calls provider.setX).
   *
   * No validation: SDK is the final arbiter of model legitimacy (see
   * .agent/DECISIONS.md #55). Typos surface as `error` events when the next
   * send fails to apply.
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

  // Status bar cycling. Renderer-only — persist to projectConfig and update
  // local status state. Backend learns the new pref on the next AGENT_SEND
  // payload (orchestrator diffs and calls provider.setX). No setPrefs IPC.
  const handleCycleModel = useCallback(() => {
    if (!capabilities || capabilities.models.length === 0) return;
    const idx = capabilities.models.findIndex((m) => m.value === statusModel);
    const next = capabilities.models[(idx + 1) % capabilities.models.length];
    handleConfigEdit('model', next.value);
  }, [capabilities, statusModel, handleConfigEdit]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.findIndex((m) => m.value === permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    handleConfigEdit('permissionMode', next.value);
  }, [capabilities, permissionMode, handleConfigEdit]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities || capabilities.effortLevels.length === 0) return;
    const idx = capabilities.effortLevels.findIndex((e) => e.value === currentEffort);
    const next = capabilities.effortLevels[(idx + 1) % capabilities.effortLevels.length];
    handleConfigEdit('effort', next.value);
  }, [capabilities, currentEffort, handleConfigEdit]);

  const handleClearHistory = useCallback(async () => {
    // Lightweight cleanup: wipe what the user sees (in-memory + IDB rows
    // for this session). Do NOT touch the agent backend, sessionId, or
    // accumulated status indicators (cost / turns / context %). The agent
    // keeps its memory — if the user wants to also reset agent context,
    // they use `/clear` slash command which has provider-side semantics
    // (Claude SDK's own /clear, Copilot's context-cleared pathway).
    await clearMessagesStore(tabId);
  }, [tabId]);

  // Slash menu memos, handleInputChange / handleSlashSelect /
  // handleKeyDown, ESC-reset on stream end, textarea auto-resize —
  // all moved to <InputZone>.

  // Turn grouping moved into <MessageList> (the only consumer).
  const currentModeOption = capabilities?.permissionModes.find((m) => m.value === permissionMode);
  const currentEffortOption = capabilities?.effortLevels.find((e) => e.value === currentEffort);

  // Auth required screen
  if (authRequired) {
    const authMethod = capabilities?.authMethod;
    const providerLabel = authRequired.provider.charAt(0).toUpperCase() + authRequired.provider.slice(1);

    const retry = async () => {
      setAuthBusy(tabId, true);
      setAuthError(tabId, null);
      // checkAuth is a query (returns Promise<boolean>), not a notify
      // — direct IPC keeps the return value. Going through emit would
      // need an inbound 'agent:onAuthChecked' event, not worth the
      // extra plumbing for a one-shot UI affordance.
      const result = await window.shelfApi.agent.checkAuth(tabId);
      if (result) {
        setAuthRequired(tabId, null);
        setAuthError(tabId, null);
      } else {
        setAuthError(tabId, 'Still no valid credentials found.');
      }
      setAuthBusy(tabId, false);
    };

    return (
      <div className="agent-view" ref={rootRef}>
        <div className="agent-auth-pane">
          <div className="agent-auth-title">
            {authMethod?.kind === 'api-key' ? `${providerLabel} API key missing` :
             authMethod?.kind === 'sdk-managed' ? `${providerLabel} SDK not signed in` :
             `${providerLabel} not authenticated`}
          </div>
          {authMethod?.kind === 'api-key' && (
            <div className="agent-auth-instructions">
              {providerLabel} needs an API key.
              {authMethod.setupUrl && <> Get one at <code>{authMethod.setupUrl}</code>.</>}
            </div>
          )}
          {(authMethod?.kind === 'sdk-managed' || authMethod?.kind === 'oauth') && (
            <>
              <div className="agent-auth-instructions">Run the following, then click Retry:</div>
              <ul className="agent-auth-list">
                {authMethod.instructions.map((ins, i) => (
                  <li key={i}>{ins.command && <code>{ins.command}</code>}{ins.label && ` — ${ins.label}`}</li>
                ))}
              </ul>
            </>
          )}
          <button className="agent-reset-btn" disabled={authBusy} onClick={retry}>
            {authBusy ? 'Checking…' : 'Retry'}
          </button>
          {authError && <div className="agent-auth-error">{authError}</div>}
        </div>
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

      {/* Priority gate: permission (agent-driven blocking) > picker (user-driven).
          When both want to show, permission takes the panel and picker state
          stays preserved; permission resolution lets picker re-render
          naturally via this conditional. See plan: UI focus rules. */}
      {pendingPermission ? (
        <SelectionPanel
          title={<>Allow <strong>{pendingPermission.toolName}</strong>?</>}
          description={<pre>{JSON.stringify(pendingPermission.input, null, 2)}</pre>}
          options={[
            { value: 'once',    label: 'Allow once',        kind: 'allow' },
            { value: 'session', label: 'Allow for session', kind: 'allow' },
            { value: 'deny',    label: 'Deny',              kind: 'deny'  },
          ]}
          onSelect={(value) => {
            if (value === 'once') handlePermissionRespond(true, 'once');
            else if (value === 'session') handlePermissionRespond(true, 'session');
            else handlePermissionRespond(false);
          }}
        />
      ) : pendingPicker ? (
        <PickerPanel
          prompts={pendingPicker.prompts}
          onSubmit={(answers) => {
            emitAgent('agent:resolvePicker', {
              tabId,
              pickerId: pendingPicker.id,
              payload: { answers },
            });
            setPendingPickerStore(tabId, null);
          }}
          onCancel={() => {
            emitAgent('agent:resolvePicker', {
              tabId,
              pickerId: pendingPicker.id,
              payload: { cancelled: true },
            });
            setPendingPickerStore(tabId, null);
          }}
        />
      ) : localPicker ? (() => {
        // Renderer-local picker for config edits (/model, future /effort
        // /permissionMode). Options + current value derived from
        // capabilities at render time — no provider roundtrip.
        const key = localPicker.key;
        const options = key === 'model'
          ? (capabilities?.models ?? []).map((m) => ({ value: m.value, label: m.displayName }))
          : key === 'effort'
            ? (capabilities?.effortLevels ?? []).map((e) => ({ value: e.value, label: e.displayName }))
            : (capabilities?.permissionModes ?? []).map((p) => ({ value: p.value, label: p.displayName }));
        const current = key === 'model' ? statusModel : key === 'effort' ? currentEffort : permissionMode;
        const title = key === 'model' ? 'Select model' : key === 'effort' ? 'Select effort' : 'Select permission mode';
        return (
          <SelectionPanel
            title={title}
            options={options}
            initialSelected={Math.max(0, options.findIndex((o) => o.value === current))}
            cancellable
            onSelect={(value) => {
              handleConfigEdit(key, value);
              setLocalPickerStore(tabId, null);
            }}
            onCancel={() => setLocalPickerStore(tabId, null)}
          />
        );
      })() : null}

      {currentPlan.trim() && (
        <div className="agent-plan-panel">
          <div className="agent-plan-header">Plan</div>
          <pre className="agent-plan-body">{currentPlan}</pre>
        </div>
      )}

      <InputZone
        tabId={tabId}
        projectId={projectId}
        cwd={cwd}
        connection={connection}
        visible={visible}
        rootRef={rootRef}
        onConfigEdit={handleConfigEdit}
      />

      <div className="agent-status-bar">
        <span className="agent-status-dot" style={{ color: isStreaming ? '#e5c07b' : '#98c379' }}>{'●'}</span>
        <span className="agent-status-label">{isStreaming ? 'running' : 'idle'}</span>
        <span className="agent-status-sep">|</span>
        <span className="agent-status-seg">{provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
        {statusModel && (
          <>
            <span className="agent-status-sep">|</span>
            <span className={`agent-status-seg${capabilities ? ' agent-status-interactive' : ''}`} onClick={handleCycleModel}>{statusModel}</span>
          </>
        )}
        {capabilities && capabilities.permissionModes.length > 0 && currentModeOption && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" data-severity={currentModeOption.severity ?? 'normal'} onClick={handleCycleMode}>
              {currentModeOption.displayName}
            </span>
          </>
        )}
        {capabilities && capabilities.effortLevels.length > 0 && currentEffortOption && (
          <>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg agent-status-interactive" data-severity={currentEffortOption.severity ?? 'normal'} onClick={handleCycleEffort}>
              <span className="agent-status-seg-label">effort: </span>{currentEffortOption.displayName}
            </span>
          </>
        )}
        {contextUsage && (
          <><span className="agent-status-sep">|</span><span className="agent-status-seg" data-severity={contextUsage.severity ?? 'normal'}>{contextUsage.text}</span></>
        )}
        {costUsd !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">${costUsd.toFixed(3)}</span></>}
        {numTurns !== undefined && <><span className="agent-status-sep">|</span><span className="agent-status-seg">{numTurns} turns</span></>}
        {rateLimits.map((seg, i) => (
          <React.Fragment key={`rl-${i}`}>
            <span className="agent-status-sep">|</span>
            <span className="agent-status-seg" data-severity={seg.severity ?? 'normal'}>{seg.text}</span>
          </React.Fragment>
        ))}
        <span style={{ marginLeft: 'auto' }} />
        <button className="agent-reset-btn" onClick={handleClearHistory} disabled={isStreaming} title="Clear visible messages (agent keeps its memory; use /clear to reset agent context)">Clear History</button>
      </div>
    </div>
  );
}
