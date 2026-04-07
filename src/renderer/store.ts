import { useState, useCallback, useSyncExternalStore } from 'react';
import type { ProjectConfig, AppSettings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/defaults';

// ── Tab state ──

export interface Tab {
  id: string;
  label: string;
  hasUnread: boolean;
}

export interface ProjectRuntime {
  config: ProjectConfig;
  tabs: Tab[];
  activeTabIndex: number;
}

// ── Global store (simple event emitter pattern) ──

let projects: ProjectRuntime[] = [];
let activeProjectIndex = 0;
let sidebarVisible = true;
let settingsVisible = false;
let searchVisible = false;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let nextTabCounter = 0;

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
  return { projects, activeProjectIndex, sidebarVisible, settingsVisible, searchVisible, settings };
}

let snapshotRef = getSnapshot();
function updateSnapshot() {
  snapshotRef = getSnapshot();
  emit();
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
  }));
  updateSnapshot();
}

export function addProject(config: ProjectConfig) {
  const runtime: ProjectRuntime = {
    config,
    tabs: [],
    activeTabIndex: 0,
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
    updateSnapshot();
  }
}

export function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  updateSnapshot();
}

export function addTab(projectIndex: number): Tab | null {
  const proj = projects[projectIndex];
  if (!proj || proj.tabs.length >= proj.config.maxTabs) return null;

  nextTabCounter++;
  const tab: Tab = {
    id: `tab-${Date.now()}-${nextTabCounter}`,
    label: `Terminal ${proj.tabs.length + 1}`,
    hasUnread: false,
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

  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, activeTabIndex: tabIndex } : p,
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

export function clearUnread(projectIndex: number, tabIndex: number) {
  const proj = projects[projectIndex];
  if (!proj || !proj.tabs[tabIndex]?.hasUnread) return;

  const tabs = proj.tabs.map((t, i) =>
    i === tabIndex ? { ...t, hasUnread: false } : t,
  );
  projects = projects.map((p, i) => (i === projectIndex ? { ...p, tabs } : p));
  updateSnapshot();
}
