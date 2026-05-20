import React from 'react';
import { SelectionPanel } from '../SelectionPanel';
import { PickerPanel } from '../PickerPanel';
import {
  setLocalPicker as setLocalPickerStore,
  setPendingPermission as setPendingPermissionStore,
  setPendingPicker as setPendingPickerStore,
  useAgentTab,
} from '../../agentTabStore';
import { emitAgent } from '../../events';

interface Props {
  tabId: string;
  /** Apply a config edit (model / effort / permissionMode change).
   *  Used by the renderer-local picker (/model) when the user selects
   *  an option. Lives in AgentView because it persists into
   *  projectConfig.agentPrefs. */
  onConfigEdit: (key: 'model' | 'effort' | 'permissionMode', value: string) => void;
}

/**
 * Mutually-exclusive panel that surfaces one of three decision UIs:
 *
 * 1. **pendingPermission** (provider-driven, agent waiting on user)
 *    — highest priority, fully blocks until resolved.
 * 2. **pendingPicker** (provider-driven via picker_request, e.g.
 *    Claude AskUserQuestion). Resolves through IPC.
 * 3. **localPicker** (renderer-only, triggered by /model and friends).
 *    Resolves locally — onConfigEdit applies, no IPC.
 *
 * Realistically permission + picker can't both be active (both gated
 * by canUseTool which SDK serializes), so the priority gate is a
 * defence-in-depth detail rather than a likely scenario.
 */
export function DecisionPanel({ tabId, onConfigEdit }: Props) {
  const tab = useAgentTab(tabId);
  const pendingPermission = tab?.pendingPermission ?? null;
  const pendingPicker = tab?.pendingPicker ?? null;
  const localPicker = tab?.localPicker ?? null;
  const capabilities = tab?.capabilities ?? null;
  const statusModel = tab?.actualModel ?? null;
  const currentEffort = tab?.actualEffort ?? 'medium';
  const permissionMode = tab?.actualPermissionMode ?? 'default';

  if (pendingPermission) {
    return (
      <SelectionPanel
        title={<>Allow <strong>{pendingPermission.toolName}</strong>?</>}
        description={<pre>{JSON.stringify(pendingPermission.input, null, 2)}</pre>}
        options={[
          { value: 'once',    label: 'Allow once',        kind: 'allow' },
          { value: 'session', label: 'Allow for session', kind: 'allow' },
          { value: 'deny',    label: 'Deny',              kind: 'deny'  },
        ]}
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
          onConfigEdit(key, value);
          setLocalPickerStore(tabId, null);
        }}
        onCancel={() => setLocalPickerStore(tabId, null)}
      />
    );
  }

  return null;
}
