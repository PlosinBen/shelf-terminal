import type {
  Project,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectId,
} from '@shared/projects';
import type { RendererProjectsRepositoryClient } from './projects-repository-client';

export interface ProjectMutationState {
  getProject(projectId: ProjectId): Project | null;
  reconcile(projects: readonly Project[]): void;
}

export class ProjectMutationRefreshError<T> extends Error {
  constructor(
    readonly operation: 'add' | 'save' | 'delete' | 'reorder',
    readonly committedResult: T,
    readonly refreshError: unknown,
  ) {
    super(`project ${operation} was committed, but renderer refresh failed: ${
      refreshError instanceof Error ? refreshError.message : String(refreshError)
    }`);
  }
}

export interface ProjectMutationCoordinator {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  getInvalidDirectoryIds(): Promise<readonly ProjectId[]>;
  add(input: ProjectCreateInput): Promise<Project>;
  save(projectId: ProjectId, changes: Partial<Omit<Project, 'id'>>): Promise<void>;
  delete(projectId: ProjectId): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
  reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>;
}

export function createProjectMutationCoordinator(
  client: RendererProjectsRepositoryClient,
  state: ProjectMutationState,
): ProjectMutationCoordinator {
  async function refresh() {
    state.reconcile(await client.getAll());
  }

  async function refreshAfterCommit<T>(
    operation: ProjectMutationRefreshError<T>['operation'],
    committedResult: T,
  ): Promise<T> {
    try {
      await refresh();
      return committedResult;
    } catch (error) {
      throw new ProjectMutationRefreshError(operation, committedResult, error);
    }
  }

  return {
    initialize: refresh,
    refresh,
    getInvalidDirectoryIds: () => client.getInvalidDirectoryIds(),

    async add(input) {
      const added = await client.add(input);
      return refreshAfterCommit('add', added);
    },

    async save(projectId, changes) {
      const current = state.getProject(projectId);
      if (!current) {
        console.warn(`[project-coordinator] no-op operation=save projectId=${projectId}: project not found`);
        return;
      }
      await client.save({ ...current, ...changes, id: current.id });
      await refreshAfterCommit('save', undefined);
    },

    async delete(projectId) {
      const result = await client.delete(projectId);
      return refreshAfterCommit('delete', result);
    },

    retryCleanup: (projectId) => client.retryCleanup(projectId),

    async reorder(sourceId, targetId) {
      await client.reorder(sourceId, targetId);
      await refreshAfterCommit('reorder', undefined);
    },
  };
}
