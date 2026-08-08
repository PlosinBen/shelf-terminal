import type {
  Project,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectId,
} from '@shared/projects';

export interface RendererProjectsRepositoryClient {
  getAll(): Promise<readonly Project[]>;
  getInvalidDirectoryIds(): Promise<readonly ProjectId[]>;
  add(input: ProjectCreateInput): Promise<Project>;
  save(project: Project): Promise<void>;
  delete(projectId: ProjectId): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
  reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>;
}

export function createRendererProjectsRepositoryClient(): RendererProjectsRepositoryClient {
  return {
    getAll: () => window.shelfApi.project.getAll(),
    getInvalidDirectoryIds: () => window.shelfApi.project.validateDirs(),
    add: (input) => window.shelfApi.project.add(input),
    save: (project) => window.shelfApi.project.update(project),
    delete: (projectId) => window.shelfApi.project.delete(projectId),
    retryCleanup: (projectId) => window.shelfApi.project.retryCleanup(projectId),
    reorder: (sourceId, targetId) => window.shelfApi.project.reorder(sourceId, targetId),
  };
}
