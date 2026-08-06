import { useSyncExternalStore } from 'react';
import type {
  BackupItemSummary,
  BackupListResult,
  BackupSource,
  ConfigBackupBinding,
  ImportItemSummary,
  ImportListIssue,
  ImportListResult,
} from '@shared/config-backup';

export type BackupPanelTab = 'backup' | 'import';
export type BackupPanelRequestKind =
  | 'load'
  | 'save-settings'
  | 'run'
  | 'find-import-sources'
  | 'load-import-source';

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
  items: BackupItemSummary[];
  intent: string[];
  selectedIds: string[];
  selectionExpanded: boolean;
  status: string | null;
  error: string | null;
  importUrl: string;
  importUrlSeeded: boolean;
  importSources: BackupSource[] | null;
  importSourceRevision: string | null;
  importItems: ImportItemSummary[] | null;
  importIssues: ImportListIssue[];
  importSelectedIds: string[];
  importError: string | null;
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
    items: [],
    intent: [],
    selectedIds: [],
    selectionExpanded: true,
    status: null,
    error: null,
    importUrl: '',
    importUrlSeeded: false,
    importSources: null,
    importSourceRevision: null,
    importItems: null,
    importIssues: [],
    importSelectedIds: [],
    importError: null,
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
  publish({ ...state, requestRevision, busy: kind, status: null, error: null });
  return { sessionRevision: state.sessionRevision, requestRevision };
}

function isCurrent(token: BackupPanelRequestToken): boolean {
  return token.sessionRevision === state.sessionRevision
    && token.requestRevision === state.requestRevision;
}

export function acceptBackupPanelList(
  token: BackupPanelRequestToken,
  result: BackupListResult,
  status: string | null = null,
): boolean {
  if (!isCurrent(token)) return false;
  const validIds = new Set(result.items.filter((item) => item.valid).map((item) => item.id));
  const selectedIds = [...new Set(result.intent)].filter((id) => validIds.has(id));
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
    items: result.items,
    intent: result.intent,
    selectedIds,
    selectionExpanded: selectedIds.length === 0,
    status,
    error: null,
    importUrl: state.importUrlSeeded ? state.importUrl : (result.binding?.remoteUrl ?? ''),
    importUrlSeeded: true,
  });
  return true;
}

export function failBackupPanelRequest(token: BackupPanelRequestToken, message: string): boolean {
  if (!isCurrent(token)) return false;
  publish({ ...state, loaded: true, busy: null, status: null, error: message });
  return true;
}

export function updateImportUrl(importUrl: string): void {
  publish({
    ...state,
    requestRevision: state.requestRevision + 1,
    busy: null,
    importUrl,
    importSources: null,
    importSourceRevision: null,
    importItems: null,
    importIssues: [],
    importSelectedIds: [],
    importError: null,
  });
}

export function startImportSourceDiscovery(): BackupPanelRequestToken {
  const token = startBackupPanelRequest('find-import-sources');
  publish({
    ...state,
    importSources: null,
    importSourceRevision: null,
    importItems: null,
    importIssues: [],
    importSelectedIds: [],
    importError: null,
  });
  return token;
}

export function acceptImportSources(
  token: BackupPanelRequestToken,
  sources: BackupSource[],
): boolean {
  if (!isCurrent(token)) return false;
  publish({
    ...state,
    busy: null,
    importSources: sources,
    importSourceRevision: null,
    importItems: null,
    importIssues: [],
    importSelectedIds: [],
    importError: null,
  });
  return true;
}

export function startImportSourceLoad(sourceRevision: string): BackupPanelRequestToken {
  const token = startBackupPanelRequest('load-import-source');
  publish({
    ...state,
    importSourceRevision: sourceRevision || null,
    importItems: null,
    importIssues: [],
    importSelectedIds: [],
    importError: null,
    busy: sourceRevision ? state.busy : null,
  });
  return token;
}

export function acceptImportItems(
  token: BackupPanelRequestToken,
  result: ImportListResult,
): boolean {
  if (!isCurrent(token)) return false;
  publish({
    ...state,
    busy: null,
    importItems: result.items,
    importIssues: result.issues,
    importSelectedIds: [],
    importError: null,
  });
  return true;
}

export function failImportPanelRequest(token: BackupPanelRequestToken, message: string): boolean {
  if (!isCurrent(token)) return false;
  publish({ ...state, busy: null, importError: message });
  return true;
}

export function toggleImportItemSelection(id: string): void {
  const item = state.importItems?.find((candidate) => candidate.id === id);
  if (!item?.valid || state.busy === 'load-import-source') return;
  const selected = new Set(state.importSelectedIds);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  publish({
    ...state,
    importSelectedIds: (state.importItems ?? [])
      .map((candidate) => candidate.id)
      .filter((candidateId) => selected.has(candidateId)),
    importError: null,
  });
}

export function selectAllValidImportItems(): void {
  publish({
    ...state,
    importSelectedIds: (state.importItems ?? [])
      .filter((item) => item.valid)
      .map((item) => item.id),
    importError: null,
  });
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
  publish({ ...state, configDraft: { ...state.configDraft, ...patch }, status: null, error: null });
}

export function setBackupSelectionExpanded(selectionExpanded: boolean): void {
  if (!selectionExpanded && state.selectedIds.length === 0) return;
  publish({ ...state, selectionExpanded, status: null, error: null });
}

export function toggleBackupItemSelection(id: string): void {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item?.valid || state.busy === 'run') return;
  const selected = new Set(state.selectedIds);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  const selectedIds = state.items
    .map((candidate) => candidate.id)
    .filter((candidateId) => selected.has(candidateId));
  publish({
    ...state,
    selectedIds,
    selectionExpanded: selectedIds.length === 0 ? true : state.selectionExpanded,
    status: null,
    error: null,
  });
}

export function isBackupConfigDirty(snapshot: BackupPanelState = state): boolean {
  const savedUrl = snapshot.binding?.remoteUrl ?? '';
  const savedLabel = snapshot.binding?.machineLabel ?? snapshot.suggestedLabel;
  return snapshot.configDraft.remoteUrl !== savedUrl
    || snapshot.configDraft.machineLabel !== savedLabel;
}
