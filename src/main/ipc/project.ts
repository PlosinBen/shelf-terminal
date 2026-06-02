import { ipcMain } from 'electron';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import { saveProjects } from '../project-store';
import { removeProjectStorage } from '../project-storage';
import { getProjects, setProjects } from '../app-state';
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
      if (!newIds.has(id)) await removeProjectStorage(id);
    }
  });

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
