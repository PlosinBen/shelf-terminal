import { inspectWorktreeSource, reconcileWorktrees, setWorktreeLifecycle } from '../worktree/reconcile';
import { ipcMain } from 'electron';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import type { ProjectCreateInput } from '@shared/projects';
import type { ProjectMutation } from '@shared/project-mutations';
import { getProjectsRepository } from '../projects/repository-provider';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC.WORKTREE_SOURCE, (_event, projectId: string) => inspectWorktreeSource(projectId));
  ipcMain.handle(IPC.WORKTREE_RECONCILE, (_event, projectId: string, stagedOrphans?: readonly import('../../shared/projects').StagedOrphan[]) => reconcileWorktrees(projectId, stagedOrphans));
  ipcMain.handle(IPC.WORKTREE_LIFECYCLE, (_event, projectId: string, active: boolean) => setWorktreeLifecycle(projectId, active));
  ipcMain.handle(IPC.PROJECT_GET_ALL, () => getProjectsRepository().getAll());
  ipcMain.handle(IPC.PROJECT_ADD, (_event, input: ProjectCreateInput) =>
    getProjectsRepository().add(input));
  ipcMain.handle(IPC.PROJECT_UPDATE, (_event, projectId: string, mutation: ProjectMutation) =>
    getProjectsRepository().mutate(projectId, mutation));
  ipcMain.handle(IPC.PROJECT_DELETE, (_event, projectId: string, expectedProjectIds?: readonly string[]) =>
    getProjectsRepository().delete(projectId, expectedProjectIds));
  ipcMain.handle(IPC.PROJECT_RETRY_CLEANUP, (_event, projectId: string) =>
    getProjectsRepository().retryCleanup(projectId));
  ipcMain.handle(IPC.PROJECT_REORDER, (_event, sourceId: string, targetId: string) =>
    getProjectsRepository().reorder(sourceId, targetId));

  ipcMain.handle(IPC.PROJECT_VALIDATE_DIRS, (): string[] => {
    const invalid: string[] = [];
    for (const project of getProjectsRepository().getAll()) {
      if (project.connection.type === 'local' && !fs.existsSync(project.cwd)) invalid.push(project.id);
    }
    return invalid;
  });
}
