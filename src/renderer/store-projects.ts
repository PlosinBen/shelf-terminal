import type {
  AgentProvider,
  ConnectionHealth,
  ConnectionHealthState,
  ProjectConfig,
  TabType,
} from '@shared/types';
import { isAgentProvider, providerLabel } from '@shared/agent-providers';
import { groupedOrder, moveGroup } from './project-grouping';
import {
  createProjectNotice,
  dismissProjectNoticeState,
  showProjectNoticeState,
  type ProjectNotice,
} from './project-notice';
import { emitStoreChange } from './store-core';

export interface Tab {
  id: string;
  label: string;
  cmd?: string;
  color?: string;
  hasUnread: boolean;
  muted: boolean;
  type: TabType;
  provider?: AgentProvider;
  url?: string;
  labelPinned?: boolean;
}

export interface ProjectRuntime {
  config: ProjectConfig;
  tabs: Tab[];
  activeTabIndex: number;
  splitTabId: string | null;
  folderInvalid: boolean;
}

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

export type ReadonlyProjectRuntime = ReadonlyDeep<ProjectRuntime>;

export interface ProjectSliceSnapshot {
  projects: readonly ReadonlyProjectRuntime[];
  activeProjectIndex: number;
  activeProjectId: string | null;
  hideDisconnected: boolean;
  editingProjectIndex: number | null;
  editingProjectId: string | null;
  connectionHealth: Record<string, ConnectionHealth>;
  projectNotice: ProjectNotice | null;
}

let projects: ProjectRuntime[] = [];
let activeProjectId: string | null = null;
let hideDisconnected = false;
let editingProjectId: string | null = null;
let nextTabCounter = 0;
let connectionHealth: Record<string, ConnectionHealth> = {};
let projectNotice: ProjectNotice | null = null;
let projectNoticeCounter = 0;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function projectIndexById(projectId: string | null): number {
  return projectId ? projects.findIndex((project) => project.config.id === projectId) : -1;
}

function projectIdAtIndex(index: number): string | null {
  return projects[index]?.config.id ?? null;
}

function reconcileActiveProject(preferredIndex = 0) {
  if (activeProjectId && projects.some((project) => project.config.id === activeProjectId)) return;
  activeProjectId = projects[preferredIndex]?.config.id ?? projects[projects.length - 1]?.config.id ?? null;
}

function publishProjectSlice() {
  emitStoreChange();
  syncToMain();
}

export function getProjectSliceSnapshot(): ProjectSliceSnapshot {
  const activeProjectIndex = projectIndexById(activeProjectId);
  const editingProjectIndex = projectIndexById(editingProjectId);
  return {
    projects: projects as readonly ReadonlyProjectRuntime[],
    activeProjectIndex,
    activeProjectId,
    hideDisconnected,
    editingProjectIndex: editingProjectIndex === -1 ? null : editingProjectIndex,
    editingProjectId,
    connectionHealth,
    projectNotice,
  };
}

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

export function setProjects(configs: ProjectConfig[]) {
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
  publishProjectSlice();
}

export function setInvalidProjects(invalidIds: string[]) {
  const idSet = new Set(invalidIds);
  projects = projects.map((project) => ({
    ...project,
    folderInvalid: idSet.has(project.config.id),
  }));
  publishProjectSlice();
}

export function addProject(config: ProjectConfig) {
  const runtime: ProjectRuntime = {
    config,
    tabs: [],
    activeTabIndex: 0,
    splitTabId: null,
    folderInvalid: false,
  };
  projects = groupedOrder([...projects, runtime]);
  activeProjectId = config.id;
  publishProjectSlice();
}

export function removeProject(index: number) {
  const removedId = projectIdAtIndex(index);
  projects = projects.filter((_, projectIndex) => projectIndex !== index);
  if (activeProjectId === removedId) {
    activeProjectId = projects[index]?.config.id ?? projects[index - 1]?.config.id ?? null;
  } else {
    reconcileActiveProject(index);
  }
  if (editingProjectId === removedId) editingProjectId = null;
  publishProjectSlice();
}

export function setActiveProject(index: number) {
  const projectId = projectIdAtIndex(index);
  if (!projectId) return;
  setActiveProjectById(projectId);
}

export function setActiveProjectById(projectId: string) {
  if (!projects.some((project) => project.config.id === projectId)) return;
  activeProjectId = projectId;
  publishProjectSlice();
}

export function getActiveProjectId() {
  return activeProjectId;
}

export function toggleHideDisconnected() {
  hideDisconnected = !hideDisconnected;
  publishProjectSlice();
}

export function getProjectIndexById(projectId: string) {
  return projectIndexById(projectId);
}

export function getProjectById(projectId: string): ProjectRuntime | null {
  return projects.find((project) => project.config.id === projectId) ?? null;
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
  publishProjectSlice();
  return projectNotice;
}

export function dismissProjectNotice(id?: string) {
  const next = dismissProjectNoticeState(projectNotice, id);
  if (next === projectNotice) return;
  projectNotice = next;
  publishProjectSlice();
}

export function expireProjectNotice(id: string) {
  dismissProjectNotice(id);
}

export function reorderProjects(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= projects.length) return;
  if (toIndex < 0 || toIndex >= projects.length) return;

  const next = moveGroup(projects, fromIndex, toIndex);
  if (next === projects) return;
  projects = next;
  reconcileActiveProject();

  publishProjectSlice();
  window.shelfApi.project.save(projects.map((project) => project.config));
}

export function reorderProjectsById(sourceProjectId: string, targetProjectId: string) {
  const fromIndex = projectIndexById(sourceProjectId);
  const toIndex = projectIndexById(targetProjectId);
  if (fromIndex === -1 || toIndex === -1) return;
  reorderProjects(fromIndex, toIndex);
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
  const project = projects[projectIndex];
  if (!project || project.tabs.length >= project.config.maxTabs) return null;
  if (type === 'agent' && provider && project.tabs.some((tab) => tab.type === 'agent' && tab.provider === provider)) {
    return null;
  }

  nextTabCounter++;
  const defaultLabel = type === 'agent'
    ? (provider ? providerLabel(provider) : 'Agent')
    : type === 'web'
      ? 'Web'
      : `Terminal ${project.tabs.length + 1}`;
  const tab: Tab = {
    id: `tab-${Date.now()}-${nextTabCounter}`,
    label: name || defaultLabel,
    cmd,
    color,
    hasUnread: false,
    muted: false,
    type,
    provider,
    ...(type === 'web' ? { url: url || undefined, labelPinned: !!name } : {}),
  };

  const updated = { ...project, tabs: [...project.tabs, tab], activeTabIndex: project.tabs.length };
  projects = projects.map((candidate, index) => (index === projectIndex ? updated : candidate));
  publishProjectSlice();
  return tab;
}

export function removeTab(projectIndex: number, tabIndex: number) {
  const project = projects[projectIndex];
  if (!project) return;

  const tabs = project.tabs.filter((_, index) => index !== tabIndex);
  let activeTabIndex = project.activeTabIndex;
  if (activeTabIndex >= tabs.length) activeTabIndex = Math.max(0, tabs.length - 1);
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs, activeTabIndex } : candidate,
  );
  publishProjectSlice();
}

export function setActiveTab(projectIndex: number, tabIndex: number) {
  const project = projects[projectIndex];
  if (!project || tabIndex < 0 || tabIndex >= project.tabs.length) return;

  const tabs = project.tabs[tabIndex].hasUnread
    ? project.tabs.map((tab, index) => (index === tabIndex ? { ...tab, hasUnread: false } : tab))
    : project.tabs;
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs, activeTabIndex: tabIndex } : candidate,
  );
  publishProjectSlice();
}

export function renameTab(projectIndex: number, tabIndex: number, name: string) {
  const project = projects[projectIndex];
  if (!project || !project.tabs[tabIndex]) return;
  const tabs = project.tabs.map((tab, index) =>
    index === tabIndex ? { ...tab, label: name, labelPinned: true } : tab,
  );
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs } : candidate,
  );
  publishProjectSlice();
}

export function webTabLabelOnNav(tab: Pick<Tab, 'label' | 'labelPinned'>, url: string): string {
  if (tab.labelPinned) return tab.label;
  try {
    return new URL(url).host || 'Web';
  } catch {
    return 'Web';
  }
}

export function setWebTabUrl(tabId: string, url: string) {
  let changed = false;
  projects = projects.map((project) => {
    if (!project.tabs.some((tab) => tab.id === tabId && tab.type === 'web')) return project;
    const tabs = project.tabs.map((tab) => {
      if (tab.id !== tabId || tab.type !== 'web') return tab;
      changed = true;
      return { ...tab, url, label: webTabLabelOnNav(tab, url) };
    });
    return { ...project, tabs };
  });
  if (changed) publishProjectSlice();
}

export function reorderTabs(projectIndex: number, fromIndex: number, toIndex: number) {
  const project = projects[projectIndex];
  if (!project || fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= project.tabs.length) return;
  if (toIndex < 0 || toIndex >= project.tabs.length) return;

  const tabs = [...project.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  tabs.splice(toIndex, 0, moved);

  let activeTabIndex = project.activeTabIndex;
  if (activeTabIndex === fromIndex) activeTabIndex = toIndex;
  else if (fromIndex < activeTabIndex && toIndex >= activeTabIndex) activeTabIndex--;
  else if (fromIndex > activeTabIndex && toIndex <= activeTabIndex) activeTabIndex++;

  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs, activeTabIndex } : candidate,
  );
  publishProjectSlice();
}

export function getProjectConfigs(): ProjectConfig[] {
  return projects.map((project) => structuredClone(project.config));
}

export function listStableProjectViews(): readonly ReadonlyProjectRuntime[] {
  return [...projects].sort((a, b) => a.config.id.localeCompare(b.config.id));
}

export function markUnread(tabId: string) {
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
    const project = projects[projectIndex];
    const tabIndex = project.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex !== -1 && tabIndex !== project.activeTabIndex) {
      if (!project.tabs[tabIndex].hasUnread) {
        const tabs = project.tabs.map((tab, index) =>
          index === tabIndex ? { ...tab, hasUnread: true } : tab,
        );
        projects = projects.map((candidate, index) =>
          index === projectIndex ? { ...candidate, tabs } : candidate,
        );
        publishProjectSlice();
      }
      return;
    }
  }
}

export function setEditingProject(index: number | null) {
  editingProjectId = index === null ? null : projectIdAtIndex(index);
  publishProjectSlice();
}

export function setEditingProjectById(projectId: string | null) {
  editingProjectId = projectId && projects.some((project) => project.config.id === projectId)
    ? projectId
    : null;
  publishProjectSlice();
}

export function updateProjectConfig(index: number, partial: Partial<ProjectConfig>) {
  const project = projects[index];
  if (!project) return;

  const config = { ...project.config, ...partial };
  projects = projects.map((candidate, projectIndex) =>
    projectIndex === index ? { ...candidate, config } : candidate,
  );
  publishProjectSlice();
  window.shelfApi.project.save(projects.map((candidate) => candidate.config));
}

export function updateProjectConfigById(projectId: string, partial: Partial<ProjectConfig>) {
  const index = projectIndexById(projectId);
  if (index === -1) return;
  updateProjectConfig(index, partial);
}

export function setSplitTab(projectIndex: number, tabId: string | null) {
  const project = projects[projectIndex];
  if (!project) return;
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, splitTabId: tabId } : candidate,
  );
  publishProjectSlice();
}

export function toggleMuted(projectIndex: number, tabIndex: number) {
  const project = projects[projectIndex];
  if (!project || !project.tabs[tabIndex]) return;

  const tab = project.tabs[tabIndex];
  const muted = !tab.muted;
  const tabs = project.tabs.map((candidate, index) =>
    index === tabIndex ? { ...candidate, muted } : candidate,
  );
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs } : candidate,
  );
  publishProjectSlice();
  window.shelfApi.pty.mute(tab.id, muted);
}

export function setTabColor(projectIndex: number, tabIndex: number, color: string | undefined) {
  const project = projects[projectIndex];
  if (!project || !project.tabs[tabIndex]) return;
  const tabs = project.tabs.map((tab, index) =>
    index === tabIndex ? { ...tab, color } : tab,
  );
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs } : candidate,
  );
  publishProjectSlice();
}

export function appendDefaultTab(projectIndex: number, name: string, color?: string) {
  const project = projects[projectIndex];
  if (!project) return;

  const existing = project.config.defaultTabs || [];
  const entry: { name: string; cmd?: string; color?: string } = { name };
  if (color) entry.color = color;
  const config = { ...project.config, defaultTabs: [...existing, entry] };
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, config } : candidate,
  );
  publishProjectSlice();
  window.shelfApi.project.save(projects.map((candidate) => candidate.config));
}

function syncToMain() {
  if (typeof window === 'undefined' || !window.shelfApi?.pm?.syncState) return;
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const state = projects.map((project) => ({
      id: project.config.id,
      name: project.config.name,
      cwd: project.config.cwd,
      connectionType: project.config.connection.type,
      active: project.config.id === activeProjectId,
      tabs: project.tabs.map((tab, tabIndex) => ({
        id: tab.id,
        label: tab.label,
        active: tabIndex === project.activeTabIndex,
      })),
    }));
    window.shelfApi.pm.syncState(state);
  }, 200);
}

export function setConnectionHealth(tabId: string, health: ConnectionHealth) {
  if (connectionHealth[tabId]?.state === health.state
    && connectionHealth[tabId]?.rttMs === health.rttMs) return;
  connectionHealth = { ...connectionHealth, [tabId]: health };
  publishProjectSlice();
}

export function clearConnectionHealth(tabId: string) {
  if (!(tabId in connectionHealth)) return;
  const next = { ...connectionHealth };
  delete next[tabId];
  connectionHealth = next;
  publishProjectSlice();
}

export const HEALTH_RANK: Record<ConnectionHealthState, number> = {
  healthy: 0,
  slow: 1,
  unstable: 2,
  dead: 3,
};

export function projectHealth(
  project: ReadonlyProjectRuntime,
  health: Record<string, ConnectionHealth>,
): ConnectionHealth | null {
  let worst: ConnectionHealth | null = null;
  for (const tab of project.tabs) {
    const tabHealth = health[tab.id];
    if (!tabHealth) continue;
    if (!worst || HEALTH_RANK[tabHealth.state] > HEALTH_RANK[worst.state]) worst = tabHealth;
  }
  return worst;
}

export function clearUnread(projectIndex: number, tabIndex: number) {
  const project = projects[projectIndex];
  if (!project || !project.tabs[tabIndex]?.hasUnread) return;
  const tabs = project.tabs.map((tab, index) =>
    index === tabIndex ? { ...tab, hasUnread: false } : tab,
  );
  projects = projects.map((candidate, index) =>
    index === projectIndex ? { ...candidate, tabs } : candidate,
  );
  publishProjectSlice();
}

export function resetProjectStoreForTests() {
  projects = [];
  activeProjectId = null;
  hideDisconnected = false;
  editingProjectId = null;
  nextTabCounter = 0;
  connectionHealth = {};
  projectNotice = null;
  projectNoticeCounter = 0;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  publishProjectSlice();
}
