import type { ProjectConfig, TabType, AgentProvider } from '@shared/types';
import { groupedOrder, moveGroup } from './project-grouping';
import type { ProjectRuntime, Tab } from './store';

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

export type ReadonlyProjectRuntime = ReadonlyDeep<ProjectRuntime>;

export interface ProjectsSnapshot {
  readonly projects: readonly ReadonlyProjectRuntime[];
  readonly activeProjectId: string | null;
}

export interface ProjectsRepositoryOptions {
  saveProjects?: (configs: ProjectConfig[]) => void | Promise<void>;
}

export interface ProjectsRepository {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ProjectsSnapshot;

  setProjects(configs: ProjectConfig[]): void;
  get(projectId: string): ReadonlyProjectRuntime | null;
  getActive(fallbackId?: string | null): ReadonlyProjectRuntime | null;
  getActiveProjectId(): string | null;
  setActiveProject(projectId: string): void;
  listVisual(): readonly ReadonlyProjectRuntime[];
  listStableViews(): readonly ReadonlyProjectRuntime[];
  has(projectId: string): boolean;

  add(config: ProjectConfig): string;
  delete(projectId: string): void;
  reorder(sourceProjectId: string, targetProjectId: string): void;
  updateConfig(projectId: string, patch: Partial<ProjectConfig>): void;
  addTab(
    projectId: string,
    name?: string,
    cmd?: string,
    color?: string,
    type?: TabType,
    provider?: AgentProvider,
    url?: string,
  ): Tab | null;
}

export function createProjectsRepository(options: ProjectsRepositoryOptions = {}): ProjectsRepository {
  let projects: ProjectRuntime[] = [];
  let activeProjectId: string | null = null;
  let nextTabCounter = 0;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function save() {
    void options.saveProjects?.(projects.map((p) => p.config));
  }

  function reconcileActiveProject() {
    if (activeProjectId && projects.some((p) => p.config.id === activeProjectId)) return;
    activeProjectId = projects[0]?.config.id ?? null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return {
        projects,
        activeProjectId,
      };
    },

    setProjects(configs) {
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
      notify();
    },

    get(projectId) {
      return projects.find((p) => p.config.id === projectId) ?? null;
    },

    getActive(fallbackId = null) {
      const id = activeProjectId ?? fallbackId;
      return id ? this.get(id) : null;
    },

    getActiveProjectId() {
      return activeProjectId;
    },

    setActiveProject(projectId) {
      if (!projects.some((p) => p.config.id === projectId)) return;
      activeProjectId = projectId;
      notify();
    },

    listVisual() {
      return projects;
    },

    listStableViews() {
      return [...projects].sort((a, b) => a.config.id.localeCompare(b.config.id));
    },

    has(projectId) {
      return projects.some((p) => p.config.id === projectId);
    },

    add(config) {
      const runtime: ProjectRuntime = {
        config,
        tabs: [],
        activeTabIndex: 0,
        splitTabId: null,
        folderInvalid: false,
      };
      projects = groupedOrder([...projects, runtime]);
      activeProjectId = config.id;
      notify();
      save();
      return config.id;
    },

    delete(projectId) {
      const next = projects.filter((p) => p.config.id !== projectId);
      if (next.length === projects.length) return;
      projects = next;
      reconcileActiveProject();
      notify();
      save();
    },

    reorder(sourceProjectId, targetProjectId) {
      const fromIndex = projects.findIndex((p) => p.config.id === sourceProjectId);
      const toIndex = projects.findIndex((p) => p.config.id === targetProjectId);
      if (fromIndex === -1 || toIndex === -1) return;
      const next = moveGroup(projects, fromIndex, toIndex);
      if (next === projects) return;
      projects = next;
      reconcileActiveProject();
      notify();
      save();
    },

    updateConfig(projectId, patch) {
      let changed = false;
      projects = projects.map((p) => {
        if (p.config.id !== projectId) return p;
        changed = true;
        return { ...p, config: { ...p.config, ...patch } };
      });
      if (!changed) return;
      notify();
      save();
    },

    addTab(projectId, name, cmd, color, type = 'terminal', provider, url) {
      const projectIndex = projects.findIndex((p) => p.config.id === projectId);
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
        ...(type === 'web' ? { url: url || undefined, labelPinned: !!name } : {}),
      };

      const updated = { ...proj, tabs: [...proj.tabs, tab], activeTabIndex: proj.tabs.length };
      projects = projects.map((p, i) => (i === projectIndex ? updated : p));
      notify();
      return tab;
    },
  };
}
