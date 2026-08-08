import type { AppSettings, UpdateStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import type { ProcessMemorySummary } from '@shared/process-memory';
import { closeBackupPanelSession, openBackupPanelSession } from './backup-panel-store';
import { emitStoreChange } from './store-core';

export interface ChatStage {
  projectId: string;
  text: string;
  images: string[];
}

export interface UiSliceSnapshot {
  sidebarVisible: boolean;
  settingsVisible: boolean;
  searchVisible: boolean;
  commandPickerVisible: boolean;
  devToolsVisible: boolean;
  notesVisible: boolean;
  skillsVisible: boolean;
  mcpVisible: boolean;
  backupVisible: boolean;
  settings: AppSettings;
  updateStatus: UpdateStatus;
  pmVisible: boolean;
  awayMode: boolean;
  pmActive: boolean;
  quickNoteVisible: boolean;
  chatStage: ChatStage | null;
  processMemorySummary: ProcessMemorySummary | null;
}

let sidebarVisible = true;
let settingsVisible = false;
let searchVisible = false;
let commandPickerVisible = false;
let devToolsVisible = false;
let notesVisible = false;
let skillsVisible = false;
let mcpVisible = false;
let backupVisible = false;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let updateStatus: UpdateStatus = { state: 'idle' };
let pmVisible = false;
let awayMode = false;
let pmActive = false;
let quickNoteVisible = false;
let chatStage: ChatStage | null = null;
let processMemorySummary: ProcessMemorySummary | null = null;

function publishUiSlice() {
  emitStoreChange();
}

export function getUiSliceSnapshot(): UiSliceSnapshot {
  return {
    sidebarVisible,
    settingsVisible,
    searchVisible,
    commandPickerVisible,
    devToolsVisible,
    notesVisible,
    skillsVisible,
    mcpVisible,
    backupVisible,
    settings,
    updateStatus,
    pmVisible,
    awayMode,
    pmActive,
    quickNoteVisible,
    chatStage,
    processMemorySummary,
  };
}

export function toggleProjectList() {
  sidebarVisible = !sidebarVisible;
  publishUiSlice();
}

export function setSettings(nextSettings: AppSettings) {
  settings = nextSettings;
  publishUiSlice();
}

export function updateSettings(partial: Partial<AppSettings>) {
  settings = { ...settings, ...partial };
  publishUiSlice();
  window.shelfApi.settings.save(settings);
}

export function toggleSettings() {
  settingsVisible = !settingsVisible;
  publishUiSlice();
}

export function getSettings(): AppSettings {
  return settings;
}

export function toggleSearch() {
  searchVisible = !searchVisible;
  publishUiSlice();
}

export function closeSearch() {
  searchVisible = false;
  publishUiSlice();
}

export function toggleCommandPicker() {
  commandPickerVisible = !commandPickerVisible;
  publishUiSlice();
}

export function closeCommandPicker() {
  commandPickerVisible = false;
  publishUiSlice();
}

export type RightSidebarFeature = 'pm' | 'notes' | 'devtools' | 'skills' | 'mcp' | 'backup';

export function toggleRightSidebar(feature: RightSidebarFeature) {
  switch (feature) {
    case 'pm':
      pmVisible = !pmVisible;
      break;
    case 'notes':
      notesVisible = !notesVisible;
      break;
    case 'devtools':
      devToolsVisible = !devToolsVisible;
      break;
    case 'skills':
      skillsVisible = !skillsVisible;
      break;
    case 'mcp':
      mcpVisible = !mcpVisible;
      break;
    case 'backup':
      backupVisible = !backupVisible;
      if (backupVisible) openBackupPanelSession();
      else closeBackupPanelSession();
      break;
  }
  publishUiSlice();
}

export function openQuickNote() {
  quickNoteVisible = true;
  publishUiSlice();
}

export function closeQuickNote() {
  quickNoteVisible = false;
  publishUiSlice();
}

export function setAwayMode(on: boolean) {
  awayMode = on;
  publishUiSlice();
}

export function setPmActive(on: boolean) {
  pmActive = on;
  publishUiSlice();
}

export function setProcessMemorySummary(summary: ProcessMemorySummary) {
  processMemorySummary = summary;
  publishUiSlice();
}

export function setUpdateStatus(status: UpdateStatus) {
  updateStatus = status;
  publishUiSlice();
}

export function setChatStage(stage: ChatStage | null) {
  chatStage = stage;
  publishUiSlice();
}

export function resetUiStoreForTests() {
  sidebarVisible = true;
  settingsVisible = false;
  searchVisible = false;
  commandPickerVisible = false;
  devToolsVisible = false;
  notesVisible = false;
  skillsVisible = false;
  mcpVisible = false;
  backupVisible = false;
  settings = { ...DEFAULT_SETTINGS };
  updateStatus = { state: 'idle' };
  pmVisible = false;
  awayMode = false;
  pmActive = false;
  quickNoteVisible = false;
  chatStage = null;
  processMemorySummary = null;
  publishUiSlice();
}
