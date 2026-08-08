import { removeProjectStorage } from '../project-storage';
import { deleteProjectSecrets } from '../secret-store';

export interface ProjectCleanup {
  cleanup(projectId: string): Promise<void>;
}

interface ProjectCleanupDependencies {
  readonly removeStorage: (projectId: string) => Promise<void>;
  readonly removeSecrets: (projectId: string) => void | Promise<void>;
}

const DEFAULT_DEPENDENCIES: ProjectCleanupDependencies = {
  removeStorage: removeProjectStorage,
  removeSecrets: deleteProjectSecrets,
};

export function createProjectCleanup(
  dependencies: ProjectCleanupDependencies = DEFAULT_DEPENDENCIES,
): ProjectCleanup {
  return {
    async cleanup(projectId) {
      const failures: unknown[] = [];
      try {
        await dependencies.removeStorage(projectId);
      } catch (error) {
        failures.push(error);
      }
      try {
        await dependencies.removeSecrets(projectId);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `cleanup failed for project ${projectId}`);
      }
    },
  };
}
