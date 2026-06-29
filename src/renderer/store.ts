import { useState, useCallback, useSyncExternalStore } from 'react';
import type { ProjectConfig, AppSettings, UpdateStatus, TabType, AgentProvider, ConnectionHealth, ConnectionHealthState } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/defaults';

// ── Tab state ──

export interface Tab {
  id: string;
  label: string;
  cmd?: string;
  color?: string;
  hasUnread: boolean;
  muted: boolean;
  type: TabType;
  provider?: AgentProvider;
  /** Web tabs only: current address shown in the address bar. */
  url?: string;
  /**
   * Web tabs only: the user renamed this tab, so navigation must not overwrite
   * its label with the page host anymore. Set by renameTab.
   */
  labelPinned?: boolean;
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
let notesVisible = false;
let skillsVisible = false;
let editingProjectIndex: number | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let updateStatus: UpdateStatus = { state: 'idle' };
let pmVisible = false;
let awayMode = false;
let pmActive = false;
let quickNoteVisible = false;
let nextTabCounter = 0;
let layoutGeneration = 0;
// Per-agent-tab connection health from the heartbeat round-trip (keyed by
// tabId). Transient — never persisted. The Sidebar aggregates per project
// (worst among the project's agent tabs) for the status dot. See §5.9.
let connectionHealth: Record<string, ConnectionHealth> = {};
// Pending payload for an agent chat input. Set by Notes' "Send to Chat" and
// consumed by the next AgentView in the matching project that becomes
// visible. Single-slot — only one staged note in flight at a time.
let chatStage: ChatStage | null = null;

export interface ChatStage {
  projectId: string;
  text: string;
  images: string[];  // data URIs
}

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
  return { projects, activeProjectIndex, sidebarVisible, settingsVisible, searchVisible, commandPickerVisible, devToolsVisible, notesVisible, skillsVisible, editingProjectIndex, settings, updateStatus, pmVisible, awayMode, pmActive, quickNoteVisible, layoutGeneration, chatStage, connectionHealth };
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

export function toggleProjectList() {
  sidebarVisible = !sidebarVisible;
  updateSnapshot();
}

export function addTab(
  projectIndex: number,
  name?: string,
  cmd?: string,
  color?: string,
  type: TabType = 'terminal',
  provider?: AgentProvider,
  url?: string,
): Tab | null {
  const proj = projects[projectIndex];
  if (!proj || proj.tabs.length >= proj.config.maxTabs) return null;

  if (type === 'agent' && provider && proj.tabs.some((t) => t.type === 'agent' && t.provider === provider)) {
    return null;
  }

  nextTabCounter++;
  const defaultLabel = type === 'agent'
    ? `${provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Agent'}`
    : type === 'web'
      ? 'Web'
      : `Terminal ${proj.tabs.length + 1}`;
  const tab: Tab = {
    id: `tab-${Date.now()}-${nextTabCounter}`,
    label: name || defaultLabel,
    cmd,
    color,
    hasUnread: false,
    muted: false,
    type,
    provider,
    // Web tabs only: carry the optional starting URL. An explicitly-named web
    // tab (e.g. a "Kibana" default tab) pins its label so navigation doesn't
    // overwrite it with the page host — an unnamed one keeps following the host.
    ...(type === 'web' ? { url: url || undefined, labelPinned: !!name } : {}),
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
    // Pin the label so a web tab's navigation no longer auto-overwrites it.
    i === tabIndex ? { ...t, label: name, labelPinned: true } : t,
  );
  projects = projects.map((p, i) =>
    i === projectIndex ? { ...p, tabs } : p,
  );
  updateSnapshot();
}

// Web tab navigated — persist its current URL and reflect the host as the tab
// label so the tab bar shows where you are. Keyed by tabId (the WebTabView only
// knows its own id, not project/tab indices).
/**
 * Web tab label on navigation: a user-pinned label (set via renameTab) is kept
 * verbatim; otherwise the label follows the page host. Pure for testability.
 */
export function webTabLabelOnNav(tab: Pick<Tab, 'label' | 'labelPinned'>, url: string): string {
  if (tab.labelPinned) return tab.label;
  try { return new URL(url).host || 'Web'; } catch { return 'Web'; }
}

export function setWebTabUrl(tabId: string, url: string) {
  let changed = false;
  projects = projects.map((p) => {
    if (!p.tabs.some((t) => t.id === tabId && t.type === 'web')) return p;
    const tabs = p.tabs.map((t) => {
      if (t.id !== tabId || t.type !== 'web') return t;
      changed = true;
      return { ...t, url, label: webTabLabelOnNav(t, url) };
    });
    return { ...p, tabs };
  });
  if (changed) updateSnapshot();
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

// ── Right sidebar actions ──

export type RightSidebarFeature = 'pm' | 'notes' | 'devtools' | 'skills';

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
  }
  updateSnapshot();
}

// ── Quick Note overlay actions ──

export function openQuickNote() {
  quickNoteVisible = true;
  updateSnapshot();
}

export function closeQuickNote() {
  quickNoteVisible = false;
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

export function setAwayMode(on: boolean) {
  awayMode = on;
  updateSnapshot();
}

export function setPmActive(on: boolean) {
  pmActive = on;
  updateSnapshot();
}

// ── State sync to main process (for PM tools) ──

let syncTimer: ReturnType<typeof setTimeout> | null = null;

function syncToMain() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    // Mark active project / active tab so main-side PM can resolve current
    // focus without a separate IPC. See pm-agent#11 and
    // tools.ts getCurrentFocus().
    const state = projects.map((p, pi) => ({
      id: p.config.id,
      name: p.config.name,
      cwd: p.config.cwd,
      connectionType: p.config.connection.type,
      active: pi === activeProjectIndex,
      tabs: p.tabs.map((t, ti) => ({
        id: t.id,
        label: t.label,
        active: ti === p.activeTabIndex,
      })),
    }));
    window.shelfApi.pm.syncState(state);
  }, 200);
}

// ── Connection health (heartbeat) ──

export function setConnectionHealth(tabId: string, health: ConnectionHealth) {
  if (connectionHealth[tabId]?.state === health.state
    && connectionHealth[tabId]?.rttMs === health.rttMs) return; // no-op, skip churn
  connectionHealth = { ...connectionHealth, [tabId]: health };
  updateSnapshot();
}

export function clearConnectionHealth(tabId: string) {
  if (!(tabId in connectionHealth)) return;
  const next = { ...connectionHealth };
  delete next[tabId];
  connectionHealth = next;
  updateSnapshot();
}

/** Worst (most degraded) health among a project's agent tabs, or null if none
 *  is being monitored yet. Degradation order: dead > unstable > slow > healthy. */
export const HEALTH_RANK: Record<ConnectionHealthState, number> = { healthy: 0, slow: 1, unstable: 2, dead: 3 };
export function projectHealth(
  project: ProjectRuntime,
  health: Record<string, ConnectionHealth>,
): ConnectionHealth | null {
  let worst: ConnectionHealth | null = null;
  for (const tab of project.tabs) {
    const h = health[tab.id];
    if (!h) continue;
    if (!worst || HEALTH_RANK[h.state] > HEALTH_RANK[worst.state]) worst = h;
  }
  return worst;
}

// ── Update actions ──

export function setUpdateStatus(status: UpdateStatus) {
  updateStatus = status;
  updateSnapshot();
}

export function setChatStage(stage: ChatStage | null) {
  chatStage = stage;
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
