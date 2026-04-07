import { useState, useCallback, useSyncExternalStore } from 'react';
import type { ProjectConfig } from '../shared/types';

// ── Tab state ──

export interface Tab {
  id: string;
  label: string;
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
  return { projects, activeProjectIndex, sidebarVisible };
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

export function getProjectConfigs(): ProjectConfig[] {
  return projects.map((p) => p.config);
}
