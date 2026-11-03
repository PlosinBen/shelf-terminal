import type {
  Project,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectId,
} from '@shared/projects';
import type { ProjectMutation, ProjectMutationResult } from '@shared/project-mutations';

export interface RendererProjectsRepositoryClient {
  getAll(): Promise<readonly Project[]>;
  getInvalidDirectoryIds(): Promise<readonly ProjectId[]>;
  add(input: ProjectCreateInput): Promise<Project>;
  save(projectId: ProjectId, mutation: ProjectMutation): Promise<ProjectMutationResult>;
  delete(projectId: ProjectId): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
  reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>;
}

export function createRendererProjectsRepositoryClient(): RendererProjectsRepositoryClient {
  return {
    getAll: () => window.shelfApi.project.getAll(),
    getInvalidDirectoryIds: () => window.shelfApi.project.validateDirs(),
    add: (input) => window.shelfApi.project.add(input),
    save: (projectId, mutation) => window.shelfApi.project.update(projectId, mutation),
    delete: (projectId) => window.shelfApi.project.delete(projectId),
    retryCleanup: (projectId) => window.shelfApi.project.retryCleanup(projectId),
    reorder: (sourceId, targetId) => window.shelfApi.project.reorder(sourceId, targetId),
  };
}
