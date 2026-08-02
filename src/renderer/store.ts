import { useState, useCallback, useSyncExternalStore } from 'react';
import type { ProjectConfig, AppSettings, UpdateStatus, TabType, AgentProvider, ConnectionHealth, ConnectionHealthState } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { groupedOrder, moveGroup } from './project-grouping';
import { createProjectNotice, dismissProjectNoticeState, showProjectNoticeState, type ProjectNotice } from './project-notice';
import { isAgentProvider, providerLabel } from '@shared/agent-providers';

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

/** Match the identity shown in Sidebar: worktree children are their branch. */
export function projectDisplayLabel(project: {
  readonly config: {
    readonly name: string;
    readonly parentProjectId?: string;
    readonly worktreeBranch?: string;
  };
}): string {
  return project.config.parentProjectId
    ? (project.config.worktreeBranch ?? project.config.name)
    : project.config.name;
}

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

export type ReadonlyProjectRuntime = ReadonlyDeep<ProjectRuntime>;

interface StoreSnapshot {
  projects: readonly ReadonlyProjectRuntime[];
  activeProjectIndex: number;
  activeProjectId: string | null;
  sidebarVisible: boolean;
  settingsVisible: boolean;
  searchVisible: boolean;
  commandPickerVisible: boolean;
  devToolsVisible: boolean;
  notesVisible: boolean;
  skillsVisible: boolean;
  mcpVisible: boolean;
  editingProjectIndex: number | null;
  editingProjectId: string | null;
  settings: AppSettings;
  updateStatus: UpdateStatus;
  pmVisible: boolean;
  awayMode: boolean;
  pmActive: boolean;
  quickNoteVisible: boolean;
  chatStage: ChatStage | null;
  connectionHealth: Record<string, ConnectionHealth>;
  projectNotice: ProjectNotice | null;
}

// ── Global store (simple event emitter pattern) ──

let projects: ProjectRuntime[] = [];
let activeProjectId: string | null = null;
let sidebarVisible = true;
let settingsVisible = false;
let searchVisible = false;
let commandPickerVisible = false;
let devToolsVisible = false;
let notesVisible = false;
let skillsVisible = false;
let mcpVisible = false;
let editingProjectId: string | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let updateStatus: UpdateStatus = { state: 'idle' };
let pmVisible = false;
let awayMode = false;
let pmActive = false;
let quickNoteVisible = false;
let nextTabCounter = 0;
// Per-agent-tab connection health from the heartbeat round-trip (keyed by
// tabId). Transient — never persisted. The Sidebar aggregates per project
// (worst among the project's agent tabs) for the status dot. See §5.9.
let connectionHealth: Record<string, ConnectionHealth> = {};
let projectNotice: ProjectNotice | null = null;
let projectNoticeCounter = 0;
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

function projectIndexById(projectId: string | null): number {
  return projectId ? projects.findIndex((p) => p.config.id === projectId) : -1;
}

function projectIdAtIndex(index: number): string | null {
  return projects[index]?.config.id ?? null;
}

function reconcileActiveProject(preferredIndex = 0) {
  if (activeProjectId && projects.some((p) => p.config.id === activeProjectId)) return;
  activeProjectId = projects[preferredIndex]?.config.id ?? projects[projects.length - 1]?.config.id ?? null;
}

function getSnapshot(): StoreSnapshot {
  const activeProjectIndex = projectIndexById(activeProjectId);
  const editingProjectIndex = projectIndexById(editingProjectId);
  return { projects: projects as readonly ReadonlyProjectRuntime[], activeProjectIndex, activeProjectId, sidebarVisible, settingsVisible, searchVisible, commandPickerVisible, devToolsVisible, notesVisible, skillsVisible, mcpVisible, editingProjectIndex: editingProjectIndex === -1 ? null : editingProjectIndex, editingProjectId, settings, updateStatus, pmVisible, awayMode, pmActive, quickNoteVisible, chatStage, connectionHealth, projectNotice };
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
  // Normalize so worktree children sit directly after their parent — persisted
  // order may predate grouping, and the flat-index invariant must hold on load.
  projects = groupedOrder(
    configs.map((config) => ({
      config,
      tabs: [],
      activeTabIndex: 0,
      splitTabId: null,
      folderInvalid: false,
    })),
  );
  reconcileActiveProject();
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
  // A worktree child lands right after its parent group (not the list tail);
  // a plain project stays at the end. groupedOrder enforces the invariant.
  projects = groupedOrder([...projects, runtime]);
  activeProjectId = config.id;
  updateSnapshot();
}

export function removeProject(index: number) {
  const removedId = projectIdAtIndex(index);
  projects = projects.filter((_, i) => i !== index);
  if (activeProjectId === removedId) {
    activeProjectId = projects[index]?.config.id ?? projects[index - 1]?.config.id ?? null;
  } else {
    reconcileActiveProject(index);
  }
  if (editingProjectId === removedId) editingProjectId = null;
  updateSnapshot();
}

export function setActiveProject(index: number) {
  const projectId = projectIdAtIndex(index);
  if (!projectId) return;
  setActiveProjectById(projectId);
}

export function setActiveProjectById(projectId: string) {
  if (!projects.some((p) => p.config.id === projectId)) return;
  activeProjectId = projectId;
  updateSnapshot();
}

export function getActiveProjectId() {
  return activeProjectId;
}

export function getProjectIndexById(projectId: string) {
  return projectIndexById(projectId);
}

export function getProjectById(projectId: string): ProjectRuntime | null {
  return projects.find((p) => p.config.id === projectId) ?? null;
}

export function getResolvedDefaultAgentProvider(projectId: string): AgentProvider | null {
  const candidate = getProjectById(projectId)?.config.defaultAgentProvider;
  return isAgentProvider(candidate) ? candidate : null;
}

export function resolveAgentProviderForOpen(
  projectId: string,
  explicitProvider?: string,
): AgentProvider | null {
  const project = getProjectById(projectId);
  if (!project) {
    console.warn(`[agent-provider] cannot resolve provider for unknown project ${projectId}`);
    return null;
  }
  const candidate = explicitProvider ?? project.config.defaultAgentProvider;
  if (isAgentProvider(candidate)) return candidate;
  console.warn(
    `[agent-provider] refusing agent open for project ${projectId}: ${
      candidate === undefined ? 'no default provider' : `invalid provider ${candidate}`
    }`,
  );
  return null;
}

export function resolveAgentProviderForConnect(projectId: string): AgentProvider | null {
  const project = getProjectById(projectId);
  if (!project?.config.openAgentOnConnect) return null;
  return resolveAgentProviderForOpen(projectId);
}

export function showProjectNotice(input: { projectId: string; message: string }): ProjectNotice {
  projectNoticeCounter++;
  projectNotice = showProjectNoticeState(
    projectNotice,
    createProjectNotice(input, `project-notice-${Date.now()}-${projectNoticeCounter}`),
  );
  updateSnapshot();
  return projectNotice;
}

export function dismissProjectNotice(id?: string) {
  const next = dismissProjectNoticeState(projectNotice, id);
  if (next === projectNotice) return;
  projectNotice = next;
  updateSnapshot();
}

export function expireProjectNotice(id: string) {
  dismissProjectNotice(id);
}

export function reorderProjects(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= projects.length) return;
  if (toIndex < 0 || toIndex >= projects.length) return;

  // Group-granular move: dragging any row drags its whole group (a project +
  // its worktree children). No-op if source/target share a group.
  const next = moveGroup(projects, fromIndex, toIndex);
  if (next === projects) return;
  projects = next;
  reconcileActiveProject();

  updateSnapshot();
  window.shelfApi.project.save(projects.map((p) => p.config));
}

export function reorderProjectsById(sourceProjectId: string, targetProjectId: string) {
  const fromIndex = projectIndexById(sourceProjectId);
  const toIndex = projectIndexById(targetProjectId);
  if (fromIndex === -1 || toIndex === -1) return;
  reorderProjects(fromIndex, toIndex);
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
    ? (provider ? providerLabel(provider) : 'Agent')
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
  return projects.map((p) => structuredClone(p.config));
}

export function listStableProjectViews(): readonly ReadonlyProjectRuntime[] {
  return [...projects].sort((a, b) => a.config.id.localeCompare(b.config.id));
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

export type RightSidebarFeature = 'pm' | 'notes' | 'devtools' | 'skills' | 'mcp';

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
  editingProjectId = index === null ? null : projectIdAtIndex(index);
  updateSnapshot();
}

export function setEditingProjectById(projectId: string | null) {
  editingProjectId = projectId && projects.some((p) => p.config.id === projectId) ? projectId : null;
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

export function updateProjectConfigById(projectId: string, partial: Partial<ProjectConfig>) {
  const index = projectIndexById(projectId);
  if (index === -1) return;
  updateProjectConfig(index, partial);
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
  if (typeof window === 'undefined' || !window.shelfApi?.pm?.syncState) return;
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
      active: p.config.id === activeProjectId,
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
  project: ReadonlyProjectRuntime,
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

export function __resetStoreForTests() {
  projects = [];
  activeProjectId = null;
  sidebarVisible = true;
  settingsVisible = false;
  searchVisible = false;
  commandPickerVisible = false;
  devToolsVisible = false;
  notesVisible = false;
  skillsVisible = false;
  mcpVisible = false;
  editingProjectId = null;
  settings = { ...DEFAULT_SETTINGS };
  updateStatus = { state: 'idle' };
  pmVisible = false;
  awayMode = false;
  pmActive = false;
  quickNoteVisible = false;
  nextTabCounter = 0;
  connectionHealth = {};
  projectNotice = null;
  projectNoticeCounter = 0;
  chatStage = null;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  updateSnapshot();
}

export function __getSnapshotForTests() {
  return snapshotRef;
}
