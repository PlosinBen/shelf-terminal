import type {
  AgentProvider,
  ConnectionHealth,
  ConnectionHealthState,
  TabType,
} from '@shared/types';
import type { Project, ProjectId, ReadonlyDeep } from '@shared/projects';
import { isAgentProvider, providerLabel } from '@shared/agent-providers';
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

export interface ProjectRuntimeState {
  tabs: Tab[];
  activeTabIndex: number;
  splitTabId: string | null;
  folderInvalid: boolean;
}

export type ProjectView = Project & ProjectRuntimeState;
export type ProjectRuntime = ProjectView;
export type ReadonlyProjectRuntime = ReadonlyDeep<ProjectView>;

export interface ProjectSliceSnapshot {
  projects: readonly ReadonlyProjectRuntime[];
  activeProjectIndex: number;
  activeProjectId: ProjectId | null;
  hideDisconnected: boolean;
  editingProjectIndex: number | null;
  editingProjectId: ProjectId | null;
  connectionHealth: Record<string, ConnectionHealth>;
  projectNotice: ProjectNotice | null;
}

let canonicalProjects: readonly Project[] = [];
let runtimeByProjectId = new Map<ProjectId, ProjectRuntimeState>();
let projects: ProjectView[] = [];
let activeProjectId: ProjectId | null = null;
let hideDisconnected = false;
let editingProjectId: ProjectId | null = null;
let nextTabCounter = 0;
let connectionHealth: Record<string, ConnectionHealth> = {};
let projectNotice: ProjectNotice | null = null;
let projectNoticeCounter = 0;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function emptyRuntime(): ProjectRuntimeState {
  return { tabs: [], activeTabIndex: 0, splitTabId: null, folderInvalid: false };
}

function rebuildProjectViews() {
  projects = canonicalProjects.map((project) => ({
    ...project,
    ...(runtimeByProjectId.get(project.id) ?? emptyRuntime()),
  }));
}

function projectIndexById(projectId: ProjectId | null): number {
  return projectId ? projects.findIndex((project) => project.id === projectId) : -1;
}

function projectIdAtIndex(index: number): ProjectId | null {
  return projects[index]?.id ?? null;
}

function reconcileActiveProject(preferredIndex = 0) {
  if (activeProjectId && canonicalProjects.some((project) => project.id === activeProjectId)) return;
  activeProjectId = canonicalProjects[preferredIndex]?.id
    ?? canonicalProjects[canonicalProjects.length - 1]?.id
    ?? null;
}

function syncToMain() {
  if (typeof window === 'undefined' || !window.shelfApi?.pm?.syncState) return;
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    window.shelfApi.pm.syncState(projects.map((project) => ({
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      connectionType: project.connection.type,
      active: project.id === activeProjectId,
      tabs: project.tabs.map((tab, tabIndex) => ({
        id: tab.id,
        label: tab.label,
        active: tabIndex === project.activeTabIndex,
      })),
    })));
  }, 200);
}

function publishProjectSlice() {
  emitStoreChange();
  syncToMain();
}

function updateRuntime(projectIndex: number, update: (runtime: ProjectRuntimeState) => ProjectRuntimeState): boolean {
  const project = projects[projectIndex];
  if (!project) return false;
  const runtime = runtimeByProjectId.get(project.id);
  if (!runtime) return false;
  runtimeByProjectId.set(project.id, update(runtime));
  rebuildProjectViews();
  publishProjectSlice();
  return true;
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

export function projectDisplayLabel(project: Pick<Project, 'name' | 'parentProjectId' | 'worktreeBranch'>): string {
  return project.parentProjectId ? (project.worktreeBranch ?? project.name) : project.name;
}

export function reconcileProjects(nextProjects: readonly Project[]) {
  const nextRuntime = new Map<ProjectId, ProjectRuntimeState>();
  for (const project of nextProjects) {
    nextRuntime.set(project.id, runtimeByProjectId.get(project.id) ?? emptyRuntime());
  }
  canonicalProjects = nextProjects;
  runtimeByProjectId = nextRuntime;
  rebuildProjectViews();
  reconcileActiveProject();
  if (editingProjectId && !nextRuntime.has(editingProjectId)) editingProjectId = null;
  publishProjectSlice();
}

export const setProjects = reconcileProjects;

export function setInvalidProjects(invalidIds: readonly string[]) {
  const invalid = new Set(invalidIds);
  for (const project of canonicalProjects) {
    const runtime = runtimeByProjectId.get(project.id) ?? emptyRuntime();
    runtimeByProjectId.set(project.id, { ...runtime, folderInvalid: invalid.has(project.id) });
  }
  rebuildProjectViews();
  publishProjectSlice();
}

export function setActiveProject(index: number) {
  const projectId = projectIdAtIndex(index);
  if (projectId) setActiveProjectById(projectId);
}

export function setActiveProjectById(projectId: ProjectId) {
  if (!canonicalProjects.some((project) => project.id === projectId)) return;
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

export function getProjectIndexById(projectId: ProjectId) {
  return projectIndexById(projectId);
}

export function getProjectById(projectId: ProjectId): ProjectView | null {
  return projects.find((project) => project.id === projectId) ?? null;
}

export function getProjectViews(): readonly ReadonlyProjectRuntime[] {
  return projects;
}

export function getCanonicalProjectById(projectId: ProjectId): Project | null {
  return canonicalProjects.find((project) => project.id === projectId) ?? null;
}

export function getResolvedDefaultAgentProvider(projectId: ProjectId): AgentProvider | null {
  const candidate = getCanonicalProjectById(projectId)?.defaultAgentProvider;
  return isAgentProvider(candidate) ? candidate : null;
}

export function resolveAgentProviderForOpen(projectId: ProjectId, explicitProvider?: string): AgentProvider | null {
  const project = getCanonicalProjectById(projectId);
  if (!project) {
    console.warn(`[agent-provider] cannot resolve provider for unknown project ${projectId}`);
    return null;
  }
  const candidate = explicitProvider ?? project.defaultAgentProvider ?? undefined;
  if (isAgentProvider(candidate)) return candidate;
  console.warn(
    `[agent-provider] refusing agent open for project ${projectId}: ${
      candidate === undefined ? 'no default provider' : `invalid provider ${candidate}`
    }`,
  );
  return null;
}

export function resolveAgentProviderForConnect(projectId: ProjectId): AgentProvider | null {
  const project = getCanonicalProjectById(projectId);
  if (!project?.openAgentOnConnect) return null;
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
  if (!project || project.tabs.length >= project.maxTabs) return null;
  if (type === 'agent' && provider && project.tabs.some((tab) => tab.type === 'agent' && tab.provider === provider)) {
    return null;
  }
  nextTabCounter++;
  const defaultLabel = type === 'agent'
    ? (provider ? providerLabel(provider) : 'Agent')
    : type === 'web' ? 'Web' : `Terminal ${project.tabs.length + 1}`;
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
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: [...runtime.tabs, tab],
    activeTabIndex: runtime.tabs.length,
  }));
  return tab;
}

/**
 * Open a visible command terminal in the project that owns `sourceTabId`.
 * The source must still be an agent tab; a stale UI event must not fall back
 * to whichever project happens to be active.
 */
export function addTerminalTabForSource(
  sourceTabId: string,
  name: string,
  command: string,
): Tab | null {
  const projectIndex = projects.findIndex((project) =>
    project.tabs.some((tab) => tab.id === sourceTabId && tab.type === 'agent'),
  );
  if (projectIndex === -1) return null;
  return addTab(projectIndex, name, command);
}

export function removeTab(projectIndex: number, tabIndex: number) {
  updateRuntime(projectIndex, (runtime) => {
    const tabs = runtime.tabs.filter((_, index) => index !== tabIndex);
    return {
      ...runtime,
      tabs,
      activeTabIndex: runtime.activeTabIndex >= tabs.length
        ? Math.max(0, tabs.length - 1)
        : runtime.activeTabIndex,
    };
  });
}

export function setActiveTab(projectIndex: number, tabIndex: number) {
  const project = projects[projectIndex];
  if (!project || tabIndex < 0 || tabIndex >= project.tabs.length) return;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs[tabIndex].hasUnread
      ? runtime.tabs.map((tab, index) => index === tabIndex ? { ...tab, hasUnread: false } : tab)
      : runtime.tabs,
    activeTabIndex: tabIndex,
  }));
}

export function renameTab(projectIndex: number, tabIndex: number, name: string) {
  const project = projects[projectIndex];
  if (!project?.tabs[tabIndex]) return;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs.map((tab, index) =>
      index === tabIndex ? { ...tab, label: name, labelPinned: true } : tab),
  }));
}

export function webTabLabelOnNav(tab: Pick<Tab, 'label' | 'labelPinned'>, url: string): string {
  if (tab.labelPinned) return tab.label;
  try { return new URL(url).host || 'Web'; } catch { return 'Web'; }
}

export function setWebTabUrl(tabId: string, url: string) {
  const projectIndex = projects.findIndex((project) => project.tabs.some((tab) => tab.id === tabId && tab.type === 'web'));
  if (projectIndex === -1) return;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs.map((tab) => tab.id === tabId && tab.type === 'web'
      ? { ...tab, url, label: webTabLabelOnNav(tab, url) }
      : tab),
  }));
}

export function reorderTabs(projectIndex: number, fromIndex: number, toIndex: number) {
  const project = projects[projectIndex];
  if (!project || fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= project.tabs.length || toIndex < 0 || toIndex >= project.tabs.length) return;
  updateRuntime(projectIndex, (runtime) => {
    const tabs = [...runtime.tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    let activeTabIndex = runtime.activeTabIndex;
    if (activeTabIndex === fromIndex) activeTabIndex = toIndex;
    else if (fromIndex < activeTabIndex && toIndex >= activeTabIndex) activeTabIndex--;
    else if (fromIndex > activeTabIndex && toIndex <= activeTabIndex) activeTabIndex++;
    return { ...runtime, tabs, activeTabIndex };
  });
}

export function listStableProjectViews(): readonly ReadonlyProjectRuntime[] {
  return [...projects].sort((a, b) => a.id.localeCompare(b.id));
}

export function markUnread(tabId: string) {
  const projectIndex = projects.findIndex((project) => project.tabs.some((tab) => tab.id === tabId));
  if (projectIndex === -1) return;
  const project = projects[projectIndex];
  const tabIndex = project.tabs.findIndex((tab) => tab.id === tabId);
  if (tabIndex === project.activeTabIndex || project.tabs[tabIndex].hasUnread) return;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs.map((tab, index) => index === tabIndex ? { ...tab, hasUnread: true } : tab),
  }));
}

export function setEditingProject(index: number | null) {
  editingProjectId = index === null ? null : projectIdAtIndex(index);
  publishProjectSlice();
}

export function setEditingProjectById(projectId: ProjectId | null) {
  editingProjectId = projectId && canonicalProjects.some((project) => project.id === projectId)
    ? projectId
    : null;
  publishProjectSlice();
}

export function setSplitTab(projectIndex: number, tabId: string | null) {
  updateRuntime(projectIndex, (runtime) => ({ ...runtime, splitTabId: tabId }));
}

export function toggleMuted(projectIndex: number, tabIndex: number) {
  const tab = projects[projectIndex]?.tabs[tabIndex];
  if (!tab) return;
  const muted = !tab.muted;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs.map((candidate, index) => index === tabIndex ? { ...candidate, muted } : candidate),
  }));
  window.shelfApi.pty.mute(tab.id, muted);
}

export function setTabColor(projectIndex: number, tabIndex: number, color: string | undefined) {
  if (!projects[projectIndex]?.tabs[tabIndex]) return;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs.map((tab, index) => index === tabIndex ? { ...tab, color } : tab),
  }));
}

export function setConnectionHealth(tabId: string, health: ConnectionHealth) {
  if (connectionHealth[tabId]?.state === health.state && connectionHealth[tabId]?.rttMs === health.rttMs) return;
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

export const HEALTH_RANK: Record<ConnectionHealthState, number> = { healthy: 0, slow: 1, unstable: 2, dead: 3 };

export function projectHealth(
  project: ReadonlyProjectRuntime,
  health: Record<string, ConnectionHealth>,
): ConnectionHealth | null {
  let worst: ConnectionHealth | null = null;
  for (const tab of project.tabs) {
    const current = health[tab.id];
    if (current && (!worst || HEALTH_RANK[current.state] > HEALTH_RANK[worst.state])) worst = current;
  }
  return worst;
}

export function clearUnread(projectIndex: number, tabIndex: number) {
  if (!projects[projectIndex]?.tabs[tabIndex]?.hasUnread) return;
  updateRuntime(projectIndex, (runtime) => ({
    ...runtime,
    tabs: runtime.tabs.map((tab, index) => index === tabIndex ? { ...tab, hasUnread: false } : tab),
  }));
}

export function resetProjectStoreForTests() {
  canonicalProjects = [];
  runtimeByProjectId = new Map();
  projects = [];
  activeProjectId = null;
  hideDisconnected = false;
  editingProjectId = null;
  nextTabCounter = 0;
  connectionHealth = {};
  projectNotice = null;
  projectNoticeCounter = 0;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  publishProjectSlice();
}
