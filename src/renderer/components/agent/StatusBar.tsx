import React, { useCallback } from 'react';
import { CONFIG_CONTROL as CC, isConfigControlPending } from '@shared/agent-config-control';
import { emitAgent } from '../../events';
import type { AgentProvider } from '@shared/types';
import { providerLabel } from '@shared/agent-providers';
import { clearMessages as clearMessagesStore, setLocalPicker, useAgentTab } from '../../agentTabStore';
import { useStore } from '../../store';
import { AgentMemory } from '../MemoryDisplay';
import { permissionControlViews, type PermissionControlView } from './permission-control-view';

interface Props {
  tabId: string;
  provider: AgentProvider;
}

/**
 * Bottom status bar — running/idle dot, provider label, clickable
 * model / mode / effort segments, context usage, cost, executions, rate-limit
 * segments, Clear History button.
 *
 * Clicking a model / mode / effort segment opens the renderer-local picker
 * (same one /model etc. open) rather than blind-cycling to the next value.
 * Cycle-on-click was easy to misfire — a stray click would silently switch
 * the model with no confirmation. Opening a dismissable picker makes a
 * misclick harmless (Esc closes it) and the selection explicit. Options come
 * from `capabilities`; status-bar selections use independent session control.
 */
export function StatusBar({ tabId, provider }: Props) {
  const tab = useAgentTab(tabId);
  const control = tab?.configControl;
  const controlsDisabled = tab?.initStatus !== 'ready' || !!(control && (isConfigControlPending(control.state) || control.state === CC.STATE.UNCERTAIN));
  const { processMemorySummary } = useStore();
  const isExecutionActive = tab?.isExecutionActive ?? false;
  const statusModel = tab?.actualModel ?? null;
  const permissionMode = tab?.actualPermissionMode ?? 'default';
  const currentEffort = tab?.capabilities?.confirmedPrefs !== undefined
    ? tab.capabilities.currentEffort : tab?.actualEffort ?? 'medium';
  const capabilities = tab?.capabilities ?? null;
  const costUsd = tab?.costUsd;
  const numTurns = tab?.numTurns;
  const contextUsage = tab?.contextUsage ?? null;
  const rateLimits = tab?.rateLimits ?? [];
  const credits = tab?.credits ?? null;

  const handleOpenModelPicker = useCallback(() => {
    if (controlsDisabled || !capabilities || capabilities.models.length === 0) return;
    setLocalPicker(tabId, { key: 'model', origin: CC.ORIGIN.STATUS_BAR });
  }, [tabId, capabilities, controlsDisabled]);

  const handleOpenPermissionPicker = useCallback((key: PermissionControlView['key']) => {
    if (!controlsDisabled) setLocalPicker(tabId, { key, origin: CC.ORIGIN.STATUS_BAR });
  }, [tabId, controlsDisabled]);

  const handleOpenEffortPicker = useCallback(() => {
    if (controlsDisabled || !capabilities || capabilities.effortLevels.length === 0) return;
    setLocalPicker(tabId, { key: 'effort', origin: CC.ORIGIN.STATUS_BAR });
  }, [tabId, capabilities, controlsDisabled]);

  const handleClearHistory = useCallback(async () => {
    // Wipes what the user sees (in-memory + IDB). Does NOT touch agent
    // backend, sessionId, or accumulated cost / executions / context %. The
    // agent keeps its memory — `/clear` slash is the provider-side reset.
    await clearMessagesStore(tabId);
  }, [tabId]);

  const permissionControls = capabilities ? permissionControlViews({
    permissionModes: capabilities.permissionModes,
    currentPermissionMode: permissionMode,
    permissionControl: capabilities.permissionControl,
  }) : [];
  const currentEffortOption = capabilities?.effortLevels.find((e) => e.value === currentEffort);

  return (
    <>
    <div className="agent-status-bar">
      <span className="agent-status-dot" style={{ color: isExecutionActive ? 'var(--agent-warning, #e5c07b)' : 'var(--agent-success, #98c379)' }}>{'●'}</span>
      <span className="agent-status-label">{isExecutionActive ? 'running' : 'idle'}</span>
      <span className="agent-status-sep">|</span>
      <span className="agent-status-seg">{providerLabel(provider)}</span>
      {statusModel && (
        <>
          <span className="agent-status-sep">|</span>
          <span
            className={`agent-status-seg${capabilities ? ' agent-status-interactive' : ''}`}
            onClick={handleOpenModelPicker}
            aria-disabled={controlsDisabled}
          >{statusModel}</span>
        </>
      )}
      {permissionControls.map((control) => {
        const current = control.options.find((option) => option.value === control.currentValue);
        const displayName = current?.displayName ?? control.currentDisplayName ?? control.currentValue;
        if (!displayName) return null;
        return (
        <React.Fragment key={control.key}>
          <span className="agent-status-sep">|</span>
          <span
            className="agent-status-seg agent-status-interactive"
            data-severity={current?.severity ?? 'normal'}
            data-config-key={control.key}
            onClick={() => handleOpenPermissionPicker(control.key)}
            aria-disabled={controlsDisabled}
          >
            {control.key === 'permissionMode'
              ? displayName
              : <><span className="agent-status-seg-label">{control.label}: </span>{displayName}</>}
          </span>
        </React.Fragment>
        );
      })}
      {capabilities && capabilities.effortLevels.length > 0 && (
        <>
          <span className="agent-status-sep">|</span>
          <span
            className="agent-status-seg agent-status-interactive"
            data-severity={currentEffortOption?.severity ?? 'normal'}
            onClick={handleOpenEffortPicker}
            aria-disabled={controlsDisabled}
          >
            <span className="agent-status-seg-label">effort: </span>{currentEffortOption?.displayName ?? currentEffort ?? 'Default'}
          </span>
        </>
      )}
      {contextUsage && (
        <>
          <span className="agent-status-sep">|</span>
          <span className="agent-status-seg" data-severity={contextUsage.severity ?? 'normal'}>{contextUsage.text}</span>
        </>
      )}
      {credits && (
        <>
          <span className="agent-status-sep">|</span>
          <span className="agent-status-seg" data-severity={credits.severity ?? 'normal'}>{credits.text}</span>
        </>
      )}
      {costUsd !== undefined && (
        <><span className="agent-status-sep">|</span><span className="agent-status-seg">${costUsd.toFixed(3)}</span></>
      )}
      {numTurns !== undefined && (
        <><span className="agent-status-sep">|</span><span className="agent-status-seg">{numTurns} executions</span></>
      )}
      {rateLimits.map((seg, i) => (
        <React.Fragment key={`rl-${i}`}>
          <span className="agent-status-sep">|</span>
          <span className="agent-status-seg" data-severity={seg.severity ?? 'normal'}>{seg.text}</span>
        </React.Fragment>
      ))}
      <span className="agent-status-sep">|</span>
      <AgentMemory rollup={processMemorySummary?.tabs[tabId]} />
      <span style={{ marginLeft: 'auto' }} />
      <button
        className="agent-reset-btn"
        onClick={handleClearHistory}
        disabled={isExecutionActive}
        title="Clear visible messages (agent keeps its memory; use /clear to reset agent context)"
      >Clear History</button>
    </div>
    {control && <div className="agent-config-feedback" role="status" data-state={control.state}>
      {control.state === CC.STATE.DEFERRED ? `Waiting for a safe boundary: ${control.key} → ${control.value}`
        : control.state === CC.STATE.APPLYING ? `Applying session setting: ${control.key} → ${control.value}`
        : control.state === CC.STATE.CONFIRMED ? `Session setting confirmed: ${control.key} = ${control.value}`
        : control.error ?? 'Session configuration was rejected'}
      {control.state === CC.STATE.UNCERTAIN && <>
        {(isExecutionActive || !!tab?.pendingSends.length) && <span>Finish or stop work and cancel queued messages before reconnecting.</span>}
        <button className="agent-reset-btn" disabled={isExecutionActive || !!tab?.pendingSends.length} onClick={() => emitAgent('agent:retryInit', { tabId })}>Reconnect</button>
      </>}
    </div>}
    </>
  );
}
