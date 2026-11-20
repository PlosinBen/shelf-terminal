import React from 'react';
import { CONFIG_CONTROL as CC } from '@shared/agent-config-control';
import { createAgentInputMessage, AGENT_INPUT_SOURCE } from '@shared/agent-input';
import { SelectionPanel } from '../SelectionPanel';
import { PickerPanel } from '../PickerPanel';
import {
  setLocalPicker as setLocalPickerStore,
  setPendingPermission as setPendingPermissionStore,
  setPendingPicker as setPendingPickerStore,
  useAgentTab,
  enqueuePendingSend,
} from '../../agentTabStore';
import { emitAgent } from '../../events';
import { permissionControlViews } from './permission-control-view';

interface Props {
  tabId: string;
}

/**
 * Mutually-exclusive panel that surfaces one of three decision UIs:
 *
 * 1. **pendingPermission** (provider-driven, agent waiting on user)
 *    — highest priority, fully blocks until resolved.
 * 2. **pendingPicker** (provider-driven via picker_request, e.g.
 *    Claude AskUserQuestion). Resolves through IPC.
 * 3. **localPicker** (renderer-only, triggered by /model and friends).
 *    Selection preserves its origin: direct session control for status-bar
 *    edits, ordinary queued slash input for slash-origin selections.
 *
 * Realistically permission + picker can't both be active (both gated
 * by canUseTool which SDK serializes), so the priority gate is a
 * defence-in-depth detail rather than a likely scenario.
 */
export function DecisionPanel({ tabId }: Props) {
  const tab = useAgentTab(tabId);
  const pendingPermission = tab?.pendingPermission ?? null;
  const pendingPicker = tab?.pendingPicker ?? null;
  const localPicker = tab?.localPicker ?? null;
  const capabilities = tab?.capabilities ?? null;
  const statusModel = tab?.actualModel ?? null;
  const currentEffort = capabilities?.confirmedPrefs !== undefined
    ? capabilities.currentEffort : tab?.actualEffort ?? 'medium';
  const permissionMode = tab?.actualPermissionMode ?? 'default';

  if (pendingPermission) {
    const options = [
      { value: 'once', label: 'Allow once', kind: 'allow' as const },
      ...(pendingPermission.constraints?.allowSession === false ? [] : [
        { value: 'session', label: 'Allow for session', kind: 'allow' as const },
      ]),
      { value: 'deny', label: 'Deny', kind: 'deny' as const },
    ];
    return (
      <SelectionPanel
        key={pendingPermission.toolUseId}
        title={<>Allow <strong>{pendingPermission.toolName}</strong>?</>}
        description={<pre>{JSON.stringify(pendingPermission.input, null, 2)}</pre>}
        options={options}
        initialSelected={pendingPermission.constraints?.defaultToDeny ? options.length - 1 : 0}
        onSelect={(value) => {
          const allow = value === 'once' || value === 'session';
          const scope = value === 'session' ? 'session' : value === 'once' ? 'once' : undefined;
          emitAgent('agent:resolvePermission', {
            tabId,
            toolUseId: pendingPermission.toolUseId,
            allow,
            scope,
          });
          setPendingPermissionStore(tabId, null);
        }}
      />
    );
  }

  if (pendingPicker) {
    return (
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
    );
  }

  if (localPicker) {
    // Renderer-local picker for config edits (/model, future /effort,
    // /permissionMode). Options + current value derived from
    // capabilities at render time — closing & reopening always
    // reflects latest state.
    const key = localPicker.key;
    const permissionControl = capabilities ? permissionControlViews({
      permissionModes: capabilities.permissionModes,
      currentPermissionMode: permissionMode,
      permissionControl: capabilities.permissionControl,
    }).find((control) => control.key === key) : undefined;
    const options = key === 'model'
      ? (capabilities?.models ?? []).map((m) => ({ value: m.value, label: m.displayName }))
      : key === 'effort'
        ? (capabilities?.effortLevels ?? []).map((e) => ({ value: e.value, label: e.displayName, description: e.description }))
        : (permissionControl?.options ?? []).map((option) => ({
            value: option.value,
            label: option.displayName,
            description: option.description,
          }));
    const current = key === 'model' ? statusModel : key === 'effort' ? currentEffort : permissionControl?.currentValue;
    const title = key === 'model'
      ? 'Select model'
      : key === 'effort'
        ? 'Select effort'
        : `Select ${permissionControl?.label ?? 'permission mode'}`;
    return (
      <SelectionPanel
        title={title}
        options={options}
        initialSelected={Math.max(0, options.findIndex((o) => o.value === current))}
        cancellable
        onSelect={(value) => {
          // Provider confirmation, never selection intent, changes displayed prefs.
          if (localPicker.origin === CC.ORIGIN.STATUS_BAR) {
            emitAgent(CC.EVENT, { tabId, key, value });
          } else {
            const content = `/${localPicker.command} ${value}`;
            const built = createAgentInputMessage({ source: { kind: AGENT_INPUT_SOURCE.AGENT_VIEW }, content });
            if (!built.ok) { console.error('Cannot create config slash message', { tabId, error: built.error }); return; }
            enqueuePendingSend(tabId, built.message.msgId, content, undefined, undefined, built.message);
            emitAgent('agent:send', { tabId, inputMessage: built.message });
          }
          setLocalPickerStore(tabId, null);
        }}
        onCancel={() => setLocalPickerStore(tabId, null)}
      />
    );
  }

  return null;
}
