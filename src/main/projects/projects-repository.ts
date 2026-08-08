import { isDeepStrictEqual } from 'node:util';
import { log } from '@shared/logger';
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

export type ProjectIdFactory = () => ProjectId;

export interface MainProjectsRepository {
  getAll(): readonly Project[];
  get(projectId: ProjectId): Project | null;
  add(input: ProjectCreateInput): Promise<Project>;
  save(project: Project): Promise<void>;
  delete(projectId: ProjectId): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
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

function createProject(id: ProjectId, input: ProjectCreateInput): Project {
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

  return detachedProject({
    id,
    name: input.name,
    cwd: input.cwd,
    connection: input.connection,
    maxTabs: input.maxTabs,
    initScript: input.initScript ?? null,
    envPlain: input.envPlain ?? {},
    defaultTabs: input.defaultTabs ?? [],
    quickCommands: input.quickCommands ?? [],
    featureNoteDir: input.featureNoteDir ?? null,
    parentProjectId: input.parentProjectId ?? null,
    worktreeBranch: input.worktreeBranch ?? null,
    baseBranch: input.baseBranch ?? null,
    defaultAgentProvider: input.defaultAgentProvider ?? null,
    openAgentOnConnect: input.openAgentOnConnect ?? false,
    agentSessionIds: {},
    agentPrefs: input.agentPrefs ?? {},
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
      return { cleanupPending: true };
    }
  }

  const repository: MainProjectsRepository = {
    getAll() {
      return projects;
    },

    get(projectId) {
      return projects.find(({ id }) => id === projectId) ?? null;
    },

    async add(input) {
      const project = createProject(createProjectId(), input);
      if (projects.some(({ id }) => id === project.id) || pendingCleanup.has(project.id)) {
        throw new ProjectRepositoryError('add', `generated duplicate project id ${project.id}`);
      }
      const candidate = readyCollection([...projects, project], 'add');
      await persist('add', candidate);
      return project;
    },

    async save(project) {
      const index = projects.findIndex(({ id }) => id === project.id);
      if (index === -1) {
        log.warn('projects-repository', `no-op operation=save projectId=${project.id}: project not found`);
        return;
      }
      const detached = detachedProject(project);
      if (isDeepStrictEqual(projects[index], detached)) return;
      const candidate = readyCollection(
        projects.map((current, projectIndex) => projectIndex === index ? detached : current),
        'save',
      );
      await persist('save', candidate);
    },

    async delete(projectId) {
      const candidate = projects.filter(({ id }) => id !== projectId);
      if (candidate.length === projects.length) return { cleanupPending: false };
      const ready = deepFreeze(candidate);
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
  return { ok: true, repository };
}
