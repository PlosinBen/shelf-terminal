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

  return {
    initialize: refresh,
    refresh,
    getInvalidDirectoryIds: () => client.getInvalidDirectoryIds(),

    async add(input) {
      const added = await client.add(input);
      await refresh();
      return added;
    },

    async save(projectId, changes) {
      const current = state.getProject(projectId);
      if (!current) {
        console.warn(`[project-coordinator] no-op operation=save projectId=${projectId}: project not found`);
        return;
      }
      await client.save({ ...current, ...changes, id: current.id });
      await refresh();
    },

    async delete(projectId) {
      const result = await client.delete(projectId);
      await refresh();
      return result;
    },

    retryCleanup: (projectId) => client.retryCleanup(projectId),

    async reorder(sourceId, targetId) {
      await client.reorder(sourceId, targetId);
      await refresh();
    },
  };
}
