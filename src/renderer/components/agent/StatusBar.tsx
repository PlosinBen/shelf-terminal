import React, { useCallback } from 'react';
import type { AgentProvider } from '@shared/types';
import { clearMessages as clearMessagesStore, useAgentTab } from '../../agentTabStore';

interface Props {
  tabId: string;
  provider: AgentProvider;
  /** Apply a config edit (model / effort / permissionMode change).
   *  Same callback used by InputZone's /model slash. Lives in AgentView
   *  because it persists into projectConfig.agentPrefs[provider]. */
  onConfigEdit: (key: 'model' | 'effort' | 'permissionMode', value: string) => void;
}

/**
 * Bottom status bar — running/idle dot, provider label, clickable
 * model / mode / effort cycles, context usage, cost, turns, rate-limit
 * segments, Clear History button.
 *
 * Reads everything from the store slice; cycle clicks call onConfigEdit
 * (which writes intent to projectConfig + sets optimistic actual* in
 * store).
 */
export function StatusBar({ tabId, provider, onConfigEdit }: Props) {
  const tab = useAgentTab(tabId);
  const isStreaming = tab?.isStreaming ?? false;
  const statusModel = tab?.actualModel ?? null;
  const permissionMode = tab?.actualPermissionMode ?? 'default';
  const currentEffort = tab?.actualEffort ?? 'medium';
  const capabilities = tab?.capabilities ?? null;
  const costUsd = tab?.costUsd;
  const numTurns = tab?.numTurns;
  const contextUsage = tab?.contextUsage ?? null;
  const rateLimits = tab?.rateLimits ?? [];

  const handleCycleModel = useCallback(() => {
    if (!capabilities || capabilities.models.length === 0) return;
    const idx = capabilities.models.findIndex((m) => m.value === statusModel);
    const next = capabilities.models[(idx + 1) % capabilities.models.length];
    onConfigEdit('model', next.value);
  }, [capabilities, statusModel, onConfigEdit]);

  const handleCycleMode = useCallback(() => {
    if (!capabilities || capabilities.permissionModes.length === 0) return;
    const idx = capabilities.permissionModes.findIndex((m) => m.value === permissionMode);
    const next = capabilities.permissionModes[(idx + 1) % capabilities.permissionModes.length];
    onConfigEdit('permissionMode', next.value);
  }, [capabilities, permissionMode, onConfigEdit]);

  const handleCycleEffort = useCallback(() => {
    if (!capabilities || capabilities.effortLevels.length === 0) return;
    const idx = capabilities.effortLevels.findIndex((e) => e.value === currentEffort);
    const next = capabilities.effortLevels[(idx + 1) % capabilities.effortLevels.length];
    onConfigEdit('effort', next.value);
  }, [capabilities, currentEffort, onConfigEdit]);

  const handleClearHistory = useCallback(async () => {
    // Wipes what the user sees (in-memory + IDB). Does NOT touch agent
    // backend, sessionId, or accumulated cost / turns / context %. The
    // agent keeps its memory — `/clear` slash is the provider-side reset.
    await clearMessagesStore(tabId);
  }, [tabId]);

  const currentModeOption = capabilities?.permissionModes.find((m) => m.value === permissionMode);
  const currentEffortOption = capabilities?.effortLevels.find((e) => e.value === currentEffort);

  return (
    <div className="agent-status-bar">
      <span className="agent-status-dot" style={{ color: isStreaming ? '#e5c07b' : '#98c379' }}>{'●'}</span>
      <span className="agent-status-label">{isStreaming ? 'running' : 'idle'}</span>
      <span className="agent-status-sep">|</span>
      <span className="agent-status-seg">{provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
      {statusModel && (
        <>
          <span className="agent-status-sep">|</span>
          <span
            className={`agent-status-seg${capabilities ? ' agent-status-interactive' : ''}`}
            onClick={handleCycleModel}
          >{statusModel}</span>
        </>
      )}
      {capabilities && capabilities.permissionModes.length > 0 && currentModeOption && (
        <>
          <span className="agent-status-sep">|</span>
          <span
            className="agent-status-seg agent-status-interactive"
            data-severity={currentModeOption.severity ?? 'normal'}
            onClick={handleCycleMode}
          >{currentModeOption.displayName}</span>
        </>
      )}
      {capabilities && capabilities.effortLevels.length > 0 && currentEffortOption && (
        <>
          <span className="agent-status-sep">|</span>
          <span
            className="agent-status-seg agent-status-interactive"
            data-severity={currentEffortOption.severity ?? 'normal'}
            onClick={handleCycleEffort}
          >
            <span className="agent-status-seg-label">effort: </span>{currentEffortOption.displayName}
          </span>
        </>
      )}
      {contextUsage && (
        <>
          <span className="agent-status-sep">|</span>
          <span className="agent-status-seg" data-severity={contextUsage.severity ?? 'normal'}>{contextUsage.text}</span>
        </>
      )}
      {costUsd !== undefined && (
        <><span className="agent-status-sep">|</span><span className="agent-status-seg">${costUsd.toFixed(3)}</span></>
      )}
      {numTurns !== undefined && (
        <><span className="agent-status-sep">|</span><span className="agent-status-seg">{numTurns} turns</span></>
      )}
      {rateLimits.map((seg, i) => (
        <React.Fragment key={`rl-${i}`}>
          <span className="agent-status-sep">|</span>
          <span className="agent-status-seg" data-severity={seg.severity ?? 'normal'}>{seg.text}</span>
        </React.Fragment>
      ))}
      <span style={{ marginLeft: 'auto' }} />
      <button
        className="agent-reset-btn"
        onClick={handleClearHistory}
        disabled={isStreaming}
        title="Clear visible messages (agent keeps its memory; use /clear to reset agent context)"
      >Clear History</button>
    </div>
  );
}
