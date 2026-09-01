import type { Project } from '@shared/projects';
import type { Connection } from '@shared/types';
import { removeProjectStorage } from '../project-storage';
import { deleteProjectSecrets } from '../secret-store';
import { createConnector } from '../connector';
import { removeTargetProjectHistory, deriveTargetHistoryPaths } from '../terminal-runner/history-path';
import { getAppInstanceId } from '../app-instance-id';
import { teardownProjectPtys } from '../pty-manager';
import { destroyProjectAgentSessions } from '../agent';

export interface ProjectCleanup {
  capture?(project: Project): void;
  cleanup(projectId: string): Promise<void>;
}

interface ProjectCleanupSnapshot {
  readonly projectId: string;
  readonly connection: Connection;
  readonly appId: string;
}

interface ProjectCleanupDependencies {
  readonly removeStorage: (projectId: string) => Promise<void>;
  readonly removeSecrets: (projectId: string) => void | Promise<void>;
  readonly teardownProject: (projectId: string) => Promise<{ confirmed: boolean; unconfirmedTabIds: string[] }>;
  readonly removeTargetHistory: typeof removeTargetProjectHistory;
  readonly createRuntime: typeof createConnector;
  readonly appId: () => string;
}

const DEFAULT_DEPENDENCIES: ProjectCleanupDependencies = {
  removeStorage: removeProjectStorage,
  removeSecrets: deleteProjectSecrets,
  teardownProject: async (projectId) => {
    await destroyProjectAgentSessions(projectId);
    return teardownProjectPtys(projectId);
  },
  removeTargetHistory: removeTargetProjectHistory,
  createRuntime: createConnector,
  appId: getAppInstanceId,
};

export class ProjectHistoryCleanupError extends Error {
  readonly name = 'ProjectHistoryCleanupError';

  constructor(
    message: string,
    readonly targetPath: string,
  ) {
    super(message);
  }
}

export function createProjectCleanup(
  overrides: Partial<ProjectCleanupDependencies> = {},
): ProjectCleanup {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const snapshots = new Map<string, ProjectCleanupSnapshot>();

  return {
    capture(project) {
      snapshots.set(project.id, {
        projectId: project.id,
        connection: project.connection as Connection,
        appId: dependencies.appId(),
      });
    },

    async cleanup(projectId) {
      const failures: unknown[] = [];
      const snapshot = snapshots.get(projectId);
      if (snapshot) {
        const runtime = dependencies.createRuntime(snapshot.connection);
        const home = await runtime.homePath();
        const targetPath = deriveTargetHistoryPaths(home, snapshot.appId, snapshot.projectId).projectRoot;
        try {
          const teardown = await dependencies.teardownProject(projectId);
          if (!teardown.confirmed) {
            throw new ProjectHistoryCleanupError(
              `terminal exit unconfirmed: ${teardown.unconfirmedTabIds.join(', ')}`,
              targetPath,
            );
          }
          await dependencies.removeTargetHistory(
            runtime, snapshot.appId, snapshot.projectId,
          );
        } catch (error) {
          failures.push(error instanceof ProjectHistoryCleanupError
            ? error
            : new ProjectHistoryCleanupError(
              error instanceof Error ? error.message : String(error),
              targetPath,
            ));
        }
      }

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
      snapshots.delete(projectId);
    },
  };
}
