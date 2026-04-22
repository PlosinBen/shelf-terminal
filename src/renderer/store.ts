import { useState, useCallback, useSyncExternalStore } from 'react';
import type { ProjectConfig, AppSettings, UpdateStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/defaults';

// ── Tab state ──

export interface Tab {
  id: string;
  label: string;
  cmd?: string;
  color?: string;
  hasUnread: boolean;
  muted: boolean;
}

export interface ProjectRuntime {
  config: ProjectConfig;
  tabs: Tab[];
  activeTabIndex: number;
  splitTabId: string | null; // tab ID shown in right pane, null = no split
  folderInvalid: boolean;
}

// ── Global store (simple event emitter pattern) ──

let projects: ProjectRuntime[] = [];
let activeProjectIndex = 0;
let sidebarVisible = true;
let settingsVisible = false;
let searchVisible = false;
let commandPickerVisible = false;
let devToolsVisible = false;
let editingProjectIndex: number | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let updateStatus: UpdateStatus = { state: 'idle' };
let pmVisible = false;
let awayMode = false;
let nextTabCounter = 0;
let layoutGeneration = 0;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return { projects, activeProjectIndex, sidebarVisible, settingsVisible, searchVisible, commandPickerVisible, devToolsVisible, editingProjectIndex, settings, updateStatus, pmVisible, awayMode, layoutGeneration };
}

let snapshotRef = getSnapshot();
function updateSnapshot() {
  snapshotRef = getSnapshot();
  emit();
  syncToMain();
}

export function useStore() {
  return useSyncExternalStore(subscribe, () => snapshotRef);
}

// ── Actions ──

export function setProjects(configs: ProjectConfig[]) {
  projects = configs.map((config) => ({
    config,
    tabs: [],
    activeTabIndex: 0,
    splitTabId: null,
    folderInvalid: false,
  }));
  updateSnapshot();
}

export function setInvalidProjects(invalidIds: string[]) {
  const idSet = new Set(invalidIds);
  projects = projects.map((p) => ({
    ...p,
    folderInvalid: idSet.has(p.config.id),
  }));
  updateSnapshot();
}

export function addProject(config: ProjectConfig) {
  const runtime: ProjectRuntime = {
    config,
    tabs: [],
    activeTabIndex: 0,
    splitTabId: null,
    folderInvalid: false,
  };
  projects = [...projects, runtime];
  activeProjectIndex = projects.length - 1;
  updateSnapshot();
}

export function removeProject(index: number) {
  projects = projects.filter((_, i) => i !== index);
  if (activeProjectIndex >= projects.length) {
    activeProjectIndex = Math.max(0, projects.length - 1);
  }
  updateSnapshot();
}

export function setActiveProject(index: number) {
  if (index >= 0 && index < projects.length) {
    activeProjectIndex = index;
    pmVisible = false;
    updateSnapshot();
  }
}

export function reorderProjects(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= projects.length) return;
  if (toIndex < 0 || toIndex >= projects.length) return;

  const items = [...projects];
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);

  // Follow the active project
  if (activeProjectIndex === fromIndex) {
    activeProjectIndex = toIndex;
  } else if (fromIndex < activeProjectIndex && toIndex >= activeProjectIndex) {
    activeProjectIndex--;
  } else if (fromIndex > activeProjectIndex && toIndex <= activeProjectIndex) {
    activeProjectIndex++;
  }

  projects = items;
  layoutGeneration++;
  updateSnapshot();
  window.shelfApi.project.save(projects.map((p) => p.config));
}

export function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  updateSnapshot();
}

export function addTab(projectIndex: number, name?: string, cmd?: string, color?: string): Tab | null {
  const proj = projects[projectIndex];
  if (!proj || proj.tabs.length >= proj.config.maxTabs) return null;

  nextTabCounter++;
  const tab: Tab = {
    id: `tab-${Date.now()}-${nextTabCounter}`,
    label: name || `Terminal ${proj.tabs.length + 1}`,
    cmd,
    color,
    hasUnread: false,
    muted: false,
  };

  const updated = { ...proj, tabs: [...proj.tabs, tab], activeTabIndex: proj.tabs.length };
  projects = projects.map((p, i) => (i === projectIndex ? updated : p));
  updateSnapshot();
  return tab;
}

export function removeTab(projectIndex: number, tabIndex: number) {
  const proj = projects[projectIndex];
  if (!proj) return;

  const tabs = proj.tabs.filter((_, i) => i !== tabIndex);
  let activeTabIndex = proj.activeTabIndex;
  if (activeTabIndex >= tabs.length) {
    activeTabIndex = Math.max(0, tabs.length - 1);
  }

  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, tabs, activeTabIndex } : p,
  );
  updateSnapshot();
}

export function setActiveTab(projectIndex: number, tabIndex: number) {
  const proj = projects[projectIndex];
  if (!proj || tabIndex < 0 || tabIndex >= proj.tabs.length) return;

  const tabs = proj.tabs[tabIndex].hasUnread
    ? proj.tabs.map((t, i) => (i === tabIndex ? { ...t, hasUnread: false } : t))
    : proj.tabs;

  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, tabs, activeTabIndex: tabIndex } : p,
  );
  updateSnapshot();
}

export function renameTab(projectIndex: number, tabIndex: number, name: string) {
  const proj = projects[projectIndex];
  if (!proj || !proj.tabs[tabIndex]) return;

  const tabs = proj.tabs.map((t, i) =>
    i === tabIndex ? { ...t, label: name } : t,
  );
  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, tabs } : p,
  );
  updateSnapshot();
}

export function reorderTabs(projectIndex: number, fromIndex: number, toIndex: number) {
  const proj = projects[projectIndex];
  if (!proj) return;
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= proj.tabs.length) return;
  if (toIndex < 0 || toIndex >= proj.tabs.length) return;

  const tabs = [...proj.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  tabs.splice(toIndex, 0, moved);

  // Adjust activeTabIndex to follow the active tab
  let activeTabIndex = proj.activeTabIndex;
  if (activeTabIndex === fromIndex) {
    activeTabIndex = toIndex;
  } else if (fromIndex < activeTabIndex && toIndex >= activeTabIndex) {
    activeTabIndex--;
  } else if (fromIndex > activeTabIndex && toIndex <= activeTabIndex) {
    activeTabIndex++;
  }

  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, tabs, activeTabIndex } : p,
  );
  updateSnapshot();
}

export function getProjectConfigs(): ProjectConfig[] {
  return projects.map((p) => p.config);
}

// ── Settings actions ──

export function setSettings(s: AppSettings) {
  settings = s;
  updateSnapshot();
}

export function updateSettings(partial: Partial<AppSettings>) {
  settings = { ...settings, ...partial };
  updateSnapshot();
  window.shelfApi.settings.save(settings);
}

export function toggleSettings() {
  settingsVisible = !settingsVisible;
  updateSnapshot();
}

export function getSettings(): AppSettings {
  return settings;
}

// ── Search actions ──

export function toggleSearch() {
  searchVisible = !searchVisible;
  updateSnapshot();
}

export function closeSearch() {
  searchVisible = false;
  updateSnapshot();
}

// ── Command picker actions ──

export function toggleCommandPicker() {
  commandPickerVisible = !commandPickerVisible;
  updateSnapshot();
}

export function closeCommandPicker() {
  commandPickerVisible = false;
  updateSnapshot();
}

// ── Dev Tools actions ──

export function toggleDevTools() {
  devToolsVisible = !devToolsVisible;
  updateSnapshot();
}

// ── Tab badge actions ──

export function markUnread(tabId: string) {
  for (let pi = 0; pi < projects.length; pi++) {
    const proj = projects[pi];
    const ti = proj.tabs.findIndex((t) => t.id === tabId);
    if (ti !== -1 && ti !== proj.activeTabIndex) {
      if (!proj.tabs[ti].hasUnread) {
        const tabs = proj.tabs.map((t, i) =>
          i === ti ? { ...t, hasUnread: true } : t,
        );
        projects = projects.map((p, i) => (i === pi ? { ...p, tabs } : p));
        updateSnapshot();
      }
      return;
    }
  }
}

// ── Project edit actions ──

export function setEditingProject(index: number | null) {
  editingProjectIndex = index;
  updateSnapshot();
}

export function updateProjectConfig(index: number, partial: Partial<ProjectConfig>) {
  const proj = projects[index];
  if (!proj) return;

  const config = { ...proj.config, ...partial };
  projects = projects.map((p, i) => (i === index ? { ...p, config } : p));
  updateSnapshot();
  window.shelfApi.project.save(projects.map((p) => p.config));
}

// ── Split pane actions ──

export function setSplitTab(projectIndex: number, tabId: string | null) {
  const proj = projects[projectIndex];
  if (!proj) return;
  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, splitTabId: tabId } : p,
  );
  updateSnapshot();
}

export function toggleMuted(projectIndex: number, tabIndex: number) {
  const proj = projects[projectIndex];
  if (!proj || !proj.tabs[tabIndex]) return;

  const tab = proj.tabs[tabIndex];
  const muted = !tab.muted;
  const tabs = proj.tabs.map((t, i) =>
    i === tabIndex ? { ...t, muted } : t,
  );
  projects = projects.map((p, i) => (i === projectIndex ? { ...p, tabs } : p));
  updateSnapshot();
  window.shelfApi.pty.mute(tab.id, muted);
}

export function setTabColor(projectIndex: number, tabIndex: number, color: string | undefined) {
  const proj = projects[projectIndex];
  if (!proj || !proj.tabs[tabIndex]) return;

  const tabs = proj.tabs.map((t, i) =>
    i === tabIndex ? { ...t, color } : t,
  );
  projects = projects.map((p, i) => (i === projectIndex ? { ...p, tabs } : p));
  updateSnapshot();
}

export function appendDefaultTab(projectIndex: number, name: string, color?: string) {
  const proj = projects[projectIndex];
  if (!proj) return;

  const existing = proj.config.defaultTabs || [];
  const entry: { name: string; cmd?: string; color?: string } = { name };
  if (color) entry.color = color;
  const config = { ...proj.config, defaultTabs: [...existing, entry] };
  projects = projects.map((p, i) => (i === projectIndex ? { ...p, config } : p));
  updateSnapshot();
  window.shelfApi.project.save(projects.map((p) => p.config));
}

// ── PM actions ──

export function setPmVisible(visible: boolean) {
  pmVisible = visible;
  updateSnapshot();
}

export function setAwayMode(on: boolean) {
  awayMode = on;
  updateSnapshot();
}

// ── State sync to main process (for PM tools) ──

let syncTimer: ReturnType<typeof setTimeout> | null = null;

function syncToMain() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const state = projects.map((p) => ({
      id: p.config.id,
      name: p.config.name,
      cwd: p.config.cwd,
      connectionType: p.config.connection.type,
      tabs: p.tabs.map((t) => ({ id: t.id, label: t.label })),
    }));
    window.shelfApi.pm.syncState(state);
  }, 200);
}

// ── Update actions ──

export function setUpdateStatus(status: UpdateStatus) {
  updateStatus = status;
  updateSnapshot();
}

export function clearUnread(projectIndex: number, tabIndex: number) {
  const proj = projects[projectIndex];
  if (!proj || !proj.tabs[tabIndex]?.hasUnread) return;

  const tabs = proj.tabs.map((t, i) =>
    i === tabIndex ? { ...t, hasUnread: false } : t,
  );
  projects = projects.map((p, i) => (i === projectIndex ? { ...p, tabs } : p));
  updateSnapshot();
}
