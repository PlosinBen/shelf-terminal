import { useSyncExternalStore } from 'react';
import type { BackupListResult, ConfigBackupBinding } from '@shared/config-backup';

export type BackupPanelTab = 'backup' | 'import';
export type BackupPanelRequestKind = 'load' | 'save-settings';

export interface BackupPanelRequestToken {
  sessionRevision: number;
  requestRevision: number;
}

interface BackupPanelState {
  sessionRevision: number;
  requestRevision: number;
  activeTab: BackupPanelTab;
  loaded: boolean;
  busy: BackupPanelRequestKind | null;
  binding: ConfigBackupBinding | null;
  suggestedLabel: string;
  configDraft: ConfigBackupBinding;
  configEditing: boolean;
  error: string | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function initialState(sessionRevision: number): BackupPanelState {
  return {
    sessionRevision,
    requestRevision: 0,
    activeTab: 'backup',
    loaded: false,
    busy: null,
    binding: null,
    suggestedLabel: '',
    configDraft: { remoteUrl: '', machineLabel: '' },
    configEditing: false,
    error: null,
  };
}

let state = initialState(0);

function publish(next: BackupPanelState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackupPanelStore(): BackupPanelState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getBackupPanelSnapshot(): BackupPanelState {
  return state;
}

export function openBackupPanelSession(): void {
  publish(initialState(state.sessionRevision + 1));
}

export function closeBackupPanelSession(): void {
  publish(initialState(state.sessionRevision + 1));
}

export function setBackupActiveTab(activeTab: BackupPanelTab): void {
  publish({ ...state, activeTab });
}

export function startBackupPanelRequest(kind: BackupPanelRequestKind): BackupPanelRequestToken {
  const requestRevision = state.requestRevision + 1;
  publish({ ...state, requestRevision, busy: kind, error: null });
  return { sessionRevision: state.sessionRevision, requestRevision };
}

function isCurrent(token: BackupPanelRequestToken): boolean {
  return token.sessionRevision === state.sessionRevision
    && token.requestRevision === state.requestRevision;
}

export function acceptBackupPanelList(
  token: BackupPanelRequestToken,
  result: BackupListResult,
): boolean {
  if (!isCurrent(token)) return false;
  const configDraft = {
    remoteUrl: result.binding?.remoteUrl ?? '',
    machineLabel: result.binding?.machineLabel ?? result.suggestedLabel,
  };
  publish({
    ...state,
    loaded: true,
    busy: null,
    binding: result.binding,
    suggestedLabel: result.suggestedLabel,
    configDraft,
    configEditing: false,
    error: null,
  });
  return true;
}

export function failBackupPanelRequest(token: BackupPanelRequestToken, message: string): boolean {
  if (!isCurrent(token)) return false;
  publish({ ...state, loaded: true, busy: null, error: message });
  return true;
}

export function beginBackupConfigEdit(): void {
  const configDraft = {
    remoteUrl: state.binding?.remoteUrl ?? '',
    machineLabel: state.binding?.machineLabel ?? state.suggestedLabel,
  };
  publish({ ...state, configDraft, configEditing: true, error: null });
}

export function cancelBackupConfigEdit(): void {
  const configDraft = {
    remoteUrl: state.binding?.remoteUrl ?? '',
    machineLabel: state.binding?.machineLabel ?? state.suggestedLabel,
  };
  publish({ ...state, configDraft, configEditing: false, error: null });
}

export function updateBackupConfigDraft(patch: Partial<ConfigBackupBinding>): void {
  publish({ ...state, configDraft: { ...state.configDraft, ...patch }, error: null });
}

export function isBackupConfigDirty(snapshot: BackupPanelState = state): boolean {
  const savedUrl = snapshot.binding?.remoteUrl ?? '';
  const savedLabel = snapshot.binding?.machineLabel ?? snapshot.suggestedLabel;
  return snapshot.configDraft.remoteUrl !== savedUrl
    || snapshot.configDraft.machineLabel !== savedLabel;
}
