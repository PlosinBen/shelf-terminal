import { ipcMain } from 'electron';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import { saveProjects } from '../project-store';
import { removeProjectStorage } from '../project-storage';
import { getProjects, setProjects } from '../app-state';
import {
  listProjectSecretKeys, setProjectSecret, deleteProjectSecret,
  deleteProjectSecrets, getKeyTier,
} from '../secret-store';
import { log } from '@shared/logger';
import type { ProjectConfig } from '@shared/types';

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC.PROJECT_LOAD, () => {
    return getProjects();
  });

  ipcMain.handle(IPC.PROJECT_SAVE, async (_event, projects: ProjectConfig[]) => {
    const oldIds = new Set(getProjects().map((p) => p.id));
    const newIds = new Set(projects.map((p) => p.id));
    setProjects(projects);
    saveProjects(projects);
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        await removeProjectStorage(id);
        try { deleteProjectSecrets(id); } catch (err: any) { log.error('project', `prune secrets for removed ${id} failed: ${err?.message ?? err}`); }
      }
    }
  });

  // ── Project secret env (encrypted; values NEVER cross back to the renderer) ──
  ipcMain.handle(IPC.PROJECT_SECRETS_LIST, (_event, projectId: string): string[] =>
    listProjectSecretKeys(projectId));

  ipcMain.handle(IPC.PROJECT_SECRET_SET, (_event, projectId: string, key: string, value: string): void =>
    setProjectSecret(projectId, key, value));

  ipcMain.handle(IPC.PROJECT_SECRET_DELETE, (_event, projectId: string, key: string): void =>
    deleteProjectSecret(projectId, key));

  ipcMain.handle(IPC.SECRET_KEY_TIER, () => getKeyTier());

  ipcMain.handle(IPC.PROJECT_VALIDATE_DIRS, (_event, projects: ProjectConfig[]): string[] => {
    const invalid: string[] = [];
    for (const p of projects) {
      if (p.connection.type === 'local' && !fs.existsSync(p.cwd)) {
        invalid.push(p.id);
      }
    }
    return invalid;
  });
}
