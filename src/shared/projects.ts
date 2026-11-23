import type { WorktreeState } from './worktree';
import type {
  AgentPrefs,
  Connection,
  QuickCommand,
  TabTemplate,
} from './types';

export type ProjectId = string;

export interface AgentViewConfig {
  readonly provider: string;
  readonly prefs: Readonly<AgentPrefs>;
}

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
  readonly connection: ReadonlyDeep<Connection>;
  readonly maxTabs: number;
  readonly initScript: string | null;
  readonly envPlain: Readonly<Record<string, string>>;
  readonly defaultTabs: readonly ReadonlyDeep<TabTemplate>[];
  readonly quickCommands: readonly ReadonlyDeep<QuickCommand>[];
  readonly featureNoteDir: string | null;
  readonly parentProjectId: ProjectId | null;
  readonly worktreeBranch: string | null;
  readonly worktreeState?: WorktreeState | null;
  readonly baseBranch: string | null;
  readonly agentViews: Readonly<Record<string, ReadonlyDeep<AgentViewConfig>>>;
}

export interface ProjectCreateInput {
  /** Create-only source in parentProjectId; main copies prefs into a fresh Agent View. */
  readonly worktreeAgentSourceSessionId?: string;
  readonly name: string;
  readonly cwd: string;
  readonly connection: ReadonlyDeep<Connection>;
  readonly maxTabs: number;
  readonly initScript?: string | null;
  readonly envPlain?: Readonly<Record<string, string>>;
  readonly defaultTabs?: readonly ReadonlyDeep<TabTemplate>[];
  readonly quickCommands?: readonly ReadonlyDeep<QuickCommand>[];
  readonly featureNoteDir?: string | null;
  readonly parentProjectId?: ProjectId | null;
  readonly worktreeBranch?: string | null;
  readonly worktreeState?: WorktreeState | null;
  readonly baseBranch?: string | null;
}

export interface ProjectDeleteResult {
  readonly cleanupPending: boolean;
  readonly leftover?: {
    readonly targetPath: string;
    readonly reason: string;
  };
}

/** The requested project and its registered descendants; never inferred from disk. */
export function projectRemovalTargets<T extends Pick<Project, 'id' | 'parentProjectId'>>(
  projects: readonly T[], projectId: ProjectId,
): T[] {
  if (!projects.some(project => project.id === projectId)) return [];
  const ids = new Set([projectId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (project.parentProjectId && ids.has(project.parentProjectId) && !ids.has(project.id)) {
        ids.add(project.id);
        changed = true;
      }
    }
  }
  return projects.filter(project => ids.has(project.id));
}

export interface StagedOrphan {
  readonly id: ProjectId;
  readonly sessionIds: readonly string[];
}

export function orphanProjects<T extends Pick<Project, 'id' | 'parentProjectId'>>(projects: readonly T[]): T[] {
  const ids = new Set(projects.map(project => project.id));
  return projects.filter(project => project.parentProjectId !== null && !ids.has(project.parentProjectId));
}

export function orphanCleanupScope(projects: readonly Project[]): StagedOrphan[] {
  return orphanProjects(projects).map(project => ({
    id: project.id, sessionIds: Object.keys(project.agentViews).sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
}
