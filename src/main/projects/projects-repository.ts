import { buildWorktreeChildConfig, WORKTREE_AGENT_SOURCE_INVALID } from '@shared/worktree-child-config';
import { isDeepStrictEqual } from 'node:util';
import { log } from '@shared/logger';
import { sameProjectTarget } from '@shared/project-target';
import { isWorktreeUnavailable } from '@shared/worktree';
import { PROJECT_MUTATION, type ProjectMutation, type ProjectMutationResult } from '@shared/project-mutations';
import { applyProjectMutation } from './project-mutation';
import { materializeAgentDefaults } from './agent-view-config';
import type {
  Project,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectId,
} from '@shared/projects';
import type {
  ProjectConfigPersistence,
  ProjectConfigPersistenceError,
} from './project-config-persistence';
import type { ProjectCleanup } from './project-cleanup';

/** Only topology invalidates a scan; session/prefs writes during Agent startup
 * must survive without preventing the connect-triggered reconciliation. */
export function sameWorktreeBaseline(a: readonly Project[], b: readonly Project[]): boolean {
  const topology = (projects: readonly Project[]) => projects.map(project => ({
    id: project.id, cwd: project.cwd, connection: project.connection,
    parentProjectId: project.parentProjectId, worktreeState: project.worktreeState,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return isDeepStrictEqual(topology(a), topology(b));
}

export type ProjectIdFactory = () => ProjectId;

export interface MainProjectsRepository {
  getAll(): readonly Project[];
  get(projectId: ProjectId): Project | null;
  add(input: ProjectCreateInput): Promise<Project>;
  save(project: Project): Promise<void>;
  mutate(projectId: ProjectId, mutation: ProjectMutation): Promise<ProjectMutationResult>;
  delete(projectId: ProjectId): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
  reconcileWorktrees(baseline: readonly Project[], updates: readonly Project[], additions: readonly ProjectCreateInput[], isCurrent?: () => boolean): Promise<readonly Project[] | null>;
  reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>;
}

export type MainProjectsRepositoryCreateResult =
  | { readonly ok: true; readonly repository: MainProjectsRepository }
  | { readonly ok: false; readonly error: ProjectConfigPersistenceError };

type ProjectRepositoryOperation = 'load' | 'add' | 'save' | 'delete' | 'reorder';

export class ProjectRepositoryError extends Error {
  readonly name = 'ProjectRepositoryError';

  constructor(
    readonly operation: ProjectRepositoryOperation,
    message: string,
    readonly persistenceError?: ProjectConfigPersistenceError,
  ) {
    super(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function detachedProject(project: Project): Project {
  return deepFreeze(structuredClone(project));
}

function groupedOrder(projects: readonly Project[]): Project[] {
  const ids = new Set(projects.map(({ id }) => id));
  const result: Project[] = [];
  const used = new Array<boolean>(projects.length).fill(false);

  for (let index = 0; index < projects.length; index++) {
    if (used[index]) continue;
    const project = projects[index];
    if (project.parentProjectId && ids.has(project.parentProjectId)) continue;

    result.push(project);
    used[index] = true;
    if (project.parentProjectId) continue;
    for (let childIndex = 0; childIndex < projects.length; childIndex++) {
      if (used[childIndex]) continue;
      if (projects[childIndex].parentProjectId === project.id) {
        result.push(projects[childIndex]);
        used[childIndex] = true;
      }
    }
  }
  return result;
}

function readyCollection(input: readonly Project[], operation: 'load' | 'add' | 'save'): readonly Project[] {
  const projects = input.map(detachedProject);
  const ids = new Set<ProjectId>();
  for (const project of projects) {
    if (!project.id || ids.has(project.id)) {
      throw new ProjectRepositoryError(
        operation,
        project.id ? `duplicate project id ${project.id}` : 'project id must not be empty',
      );
    }
    ids.add(project.id);
  }
  return deepFreeze(groupedOrder(projects));
}

function createProject(id: ProjectId, input: ProjectCreateInput, parent?: Project): Project {
  if (!id) throw new ProjectRepositoryError('add', 'generated project id must not be empty');
  if (typeof input.name !== 'string' || typeof input.cwd !== 'string') {
    throw new ProjectRepositoryError('add', 'project name and cwd must be strings');
  }
  if (!Number.isInteger(input.maxTabs) || input.maxTabs <= 0) {
    throw new ProjectRepositoryError('add', 'project maxTabs must be a positive integer');
  }
  if (typeof input.connection !== 'object' || input.connection === null) {
    throw new ProjectRepositoryError('add', 'project connection must be an object');
  }
  const defaultTabs = input.defaultTabs ?? [{ name: 'Terminal' }];
  if (defaultTabs.length === 0) {
    throw new ProjectRepositoryError('add', 'project defaultTabs must not be empty');
  }

  const agents = materializeAgentDefaults(defaultTabs, {});
  if (input.worktreeAgentSourceSessionId !== undefined) {
    const sourceId = input.worktreeAgentSourceSessionId;
    const source = typeof sourceId === 'string' && parent && parent.id === input.parentProjectId
      ? parent.agentViews[sourceId] : undefined;
    const targets = Object.entries(agents.agentViews);
    if (!source || targets.length !== 1 || targets[0][1].provider !== source.provider) {
      throw new ProjectRepositoryError('add', WORKTREE_AGENT_SOURCE_INVALID);
    }
    agents.agentViews[targets[0][0]] = { provider: source.provider, prefs: { ...source.prefs } };
  }

  return detachedProject({
    id,
    name: input.name,
    cwd: input.cwd,
    connection: input.connection,
    maxTabs: input.maxTabs,
    initScript: input.initScript ?? null,
    envPlain: input.envPlain ?? {},
    ...agents,
    quickCommands: input.quickCommands ?? [],
    featureNoteDir: input.featureNoteDir ?? null,
    parentProjectId: input.parentProjectId ?? null,
    worktreeBranch: input.worktreeBranch ?? null,
    ...(input.worktreeState !== undefined ? { worktreeState: input.worktreeState } : {}),
    baseBranch: input.baseBranch ?? null,
  });
}

function groups(projects: readonly Project[]): number[][] {
  const result: number[][] = [];
  for (let index = 0; index < projects.length; index++) {
    const parentId = projects[index].parentProjectId;
    const previous = result[result.length - 1];
    if (parentId && previous && projects[previous[0]].id === parentId) previous.push(index);
    else result.push([index]);
  }
  return result;
}

function moveProjectGroup(
  projects: readonly Project[],
  sourceIndex: number,
  targetIndex: number,
): readonly Project[] {
  const projectGroups = groups(projects);
  const sourceGroup = projectGroups.findIndex((group) => group.includes(sourceIndex));
  const targetGroup = projectGroups.findIndex((group) => group.includes(targetIndex));
  if (sourceGroup === -1 || targetGroup === -1 || sourceGroup === targetGroup) return projects;

  const order = projectGroups.slice();
  const [moved] = order.splice(sourceGroup, 1);
  order.splice(targetGroup, 0, moved);
  return deepFreeze(order.flatMap((group) => group.map((index) => projects[index])));
}

function persistenceFailure(
  operation: ProjectRepositoryOperation,
  error: ProjectConfigPersistenceError,
): ProjectRepositoryError {
  return new ProjectRepositoryError(
    operation,
    `project ${operation} persistence failed at ${error.stage}: ${error.message}`,
    error,
  );
}

export function createMainProjectsRepository(
  config: ProjectConfigPersistence,
  createProjectId: ProjectIdFactory,
  cleanup: ProjectCleanup,
): MainProjectsRepositoryCreateResult {
  const loaded = config.load();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  let projects = readyCollection(loaded.value, 'load');
  const pendingCleanup = new Set<ProjectId>();

  async function persist(
    operation: Exclude<ProjectRepositoryOperation, 'load'>,
    candidate: readonly Project[],
  ) {
    const saved = await config.save(candidate);
    if (!saved.ok) throw persistenceFailure(operation, saved.error);
    projects = candidate;
  }

  async function runCleanup(projectId: ProjectId): Promise<ProjectDeleteResult> {
    try {
      await cleanup.cleanup(projectId);
      pendingCleanup.delete(projectId);
      return { cleanupPending: false };
    } catch (error) {
      log.error(
        'projects-repository',
        `operation=cleanup projectId=${projectId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const historyFailure = error instanceof AggregateError
        ? error.errors.find((candidate) => candidate && typeof candidate === 'object' && 'targetPath' in candidate)
        : undefined;
      return {
        cleanupPending: true,
        ...(historyFailure && typeof historyFailure === 'object' && 'targetPath' in historyFailure
          ? {
            leftover: {
              targetPath: String(historyFailure.targetPath),
              reason: historyFailure instanceof Error ? historyFailure.message : 'target cleanup failed',
            },
          }
          : {}),
      };
    }
  }

  const repository: MainProjectsRepository = {
    getAll() {
      return projects;
    },

    get(projectId) {
      return projects.find(({ id }) => id === projectId) ?? null;
    },

    async reconcileWorktrees(baseline, updates, additions, isCurrent = () => true) {
      if (!sameWorktreeBaseline(projects, baseline) || !isCurrent()) return null;
      const created = additions.map(input => {
        const parent = projects.find(project => project.id === input.parentProjectId);
        const latestInput = parent ? {
          ...buildWorktreeChildConfig(parent, { cwd: input.cwd, worktreeBranch: input.worktreeBranch ?? null, baseBranch: input.baseBranch ?? undefined }),
          worktreeState: input.worktreeState,
        } : input;
        return createProject(createProjectId(), latestInput);
      });
      const candidate = readyCollection([
        ...projects.map(project => {
          const update = updates.find(update => update.id === project.id);
          return update ? { ...project, worktreeBranch: update.worktreeBranch, worktreeState: update.worktreeState } : project;
        }),
        ...created,
      ], 'save');
      for (const child of created) {
        const duplicate = candidate.find(other => other.id !== child.id && sameProjectTarget(other, child));
        if (duplicate) {
          const parent = candidate.find(project => project.id === child.parentProjectId);
          const owner = candidate.find(project => project.id === duplicate.parentProjectId);
          const label = (project: Project) => `"${project.name}" (ID: ${project.id})`;
          const duplicateMains = parent && owner && parent.id !== owner.id
            && !parent.parentProjectId && !owner.parentProjectId && sameProjectTarget(parent, owner);
          const reason = duplicateMains
            ? `Duplicate main projects: ${label(parent)} and ${label(owner)} point to the same target (${parent.cwd}). `
            : '';
          throw new ProjectRepositoryError('add',
            `Worktree scan could not complete. ${reason}`
            + `The worktree at ${child.cwd} is already registered as ${label(duplicate)}`
            + (owner ? ` under main project ${label(owner)}. ` : '. ')
            + 'No scan updates were saved; existing project data and Git worktrees were not changed. '
            + 'Review the conflicting project entries and their worktree children before removing any entry. '
            + 'Rescanning will fail again while this conflict remains.');
        }
      }
      if (isDeepStrictEqual(candidate, projects)) return projects;
      await persist('save', candidate);
      return projects;
    },

    async add(input) {
      const parent = projects.find(project => project.id === input.parentProjectId);
      const project = createProject(createProjectId(), input, parent);
      if (projects.some(({ id }) => id === project.id) || pendingCleanup.has(project.id)) {
        throw new ProjectRepositoryError('add', `generated duplicate project id ${project.id}`);
      }
      const duplicate = projects.find((existing) => sameProjectTarget(existing, project));
      if (duplicate) {
        throw new ProjectRepositoryError(
          'add',
          `duplicate project target matches project ${duplicate.id}`,
        );
      }
      const candidate = readyCollection([...projects, project], 'add');
      await persist('add', candidate);
      return project;
    },

    async mutate(projectId, mutation) {
      const current = projects.find(project => project.id === projectId);
      if (!current) throw new ProjectRepositoryError('save', `Project not found: ${projectId}`);
      if (isWorktreeUnavailable(current) && mutation.kind !== PROJECT_MUTATION.FORGET_AGENT_VIEW) throw new ProjectRepositoryError('save', 'Worktree is unavailable; rescan before editing');
      const result = applyProjectMutation(current, mutation);
      if (!result.ok) return result;
      if (!isDeepStrictEqual(current, result.project)) {
        const candidate = readyCollection(projects.map(project => project.id === projectId ? result.project : project), 'save');
        await persist('save', candidate);
      }
      return { ok: true, ...(result.sessionId ? { sessionId: result.sessionId } : {}) };
    },

    async save(project) {
      const index = projects.findIndex(({ id }) => id === project.id);
      if (index === -1) {
        log.warn('projects-repository', `no-op operation=save projectId=${project.id}: project not found`);
        return;
      }
      const current = projects[index];
      const detached = detachedProject(current.worktreeState === undefined ? project : {
        ...project, worktreeState: current.worktreeState, worktreeBranch: current.worktreeBranch,
      });
      if (isDeepStrictEqual(projects[index], detached)) return;
      const candidate = readyCollection(
        projects.map((current, projectIndex) => projectIndex === index ? detached : current),
        'save',
      );
      await persist('save', candidate);
    },

    async delete(projectId) {
      const removed = projects.find(({ id }) => id === projectId);
      const candidate = projects.filter(({ id }) => id !== projectId);
      if (candidate.length === projects.length) return { cleanupPending: false };
      const ready = deepFreeze(candidate);
      if (removed) cleanup.capture?.(removed);
      await persist('delete', ready);
      pendingCleanup.add(projectId);
      return runCleanup(projectId);
    },

    async retryCleanup(projectId) {
      if (!pendingCleanup.has(projectId)) return { cleanupPending: false };
      return runCleanup(projectId);
    },

    async reorder(sourceId, targetId) {
      const sourceIndex = projects.findIndex(({ id }) => id === sourceId);
      const targetIndex = projects.findIndex(({ id }) => id === targetId);
      if (sourceIndex === -1 || targetIndex === -1) {
        log.warn(
          'projects-repository',
          `no-op operation=reorder sourceId=${sourceId} targetId=${targetId}: project not found`,
        );
        return;
      }
      const candidate = moveProjectGroup(projects, sourceIndex, targetIndex);
      if (candidate === projects) return;
      await persist('reorder', candidate);
    },
  };
  // Serialize candidate construction as well as persistence. Otherwise an add
  // awaiting disk can overwrite a later save or reconciliation snapshot.
  let writes: Promise<unknown> = Promise.resolve();
  function serialize<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return (...args) => {
      const result = writes.then(() => operation(...args));
      writes = result.catch(() => undefined); // caller still receives rejection
      return result;
    };
  }
  repository.add = serialize(repository.add);
  repository.save = serialize(repository.save);
  repository.mutate = serialize(repository.mutate);
  repository.delete = serialize(repository.delete);
  repository.reorder = serialize(repository.reorder);
  repository.reconcileWorktrees = serialize(repository.reconcileWorktrees);
  return { ok: true, repository };
}
