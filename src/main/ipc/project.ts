import { ipcMain } from 'electron';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import type { Project, ProjectCreateInput } from '@shared/projects';
import { getProjectsRepository } from '../projects/repository-provider';
import {
  listProjectSecretKeys,
  setProjectSecret,
  deleteProjectSecret,
  copyProjectSecrets,
  getKeyTier,
} from '../secret-store';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC.PROJECT_GET_ALL, () => getProjectsRepository().getAll());
  ipcMain.handle(IPC.PROJECT_ADD, (_event, input: ProjectCreateInput) =>
    getProjectsRepository().add(input));
  ipcMain.handle(IPC.PROJECT_UPDATE, (_event, project: Project) =>
    getProjectsRepository().save(project));
  ipcMain.handle(IPC.PROJECT_DELETE, (_event, projectId: string) =>
    getProjectsRepository().delete(projectId));
  ipcMain.handle(IPC.PROJECT_RETRY_CLEANUP, (_event, projectId: string) =>
    getProjectsRepository().retryCleanup(projectId));
  ipcMain.handle(IPC.PROJECT_REORDER, (_event, sourceId: string, targetId: string) =>
    getProjectsRepository().reorder(sourceId, targetId));

  ipcMain.handle(IPC.PROJECT_SECRETS_LIST, (_event, projectId: string): string[] =>
    listProjectSecretKeys(projectId));
  ipcMain.handle(IPC.PROJECT_SECRET_SET, (_event, projectId: string, key: string, value: string): void =>
    setProjectSecret(projectId, key, value));
  ipcMain.handle(IPC.PROJECT_SECRET_DELETE, (_event, projectId: string, key: string): void =>
    deleteProjectSecret(projectId, key));
  ipcMain.handle(IPC.PROJECT_SECRETS_COPY, (_event, fromId: string, toId: string): void =>
    copyProjectSecrets(fromId, toId));
  ipcMain.handle(IPC.SECRET_KEY_TIER, () => getKeyTier());

  ipcMain.handle(IPC.PROJECT_VALIDATE_DIRS, (): string[] => {
    const invalid: string[] = [];
    for (const project of getProjectsRepository().getAll()) {
      if (project.connection.type === 'local' && !fs.existsSync(project.cwd)) invalid.push(project.id);
    }
    return invalid;
  });
}
