import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';

// Per-project storage layout:
//   <userData>/projects/<projectId>/
//     pm-note.md        — PM agent project note
//     notes.md          — user-facing markdown scratch pad
//     images/<uuid>.png — pasted images for notes
//
// New per-project artifacts should live under projectDir(id) so that
// removing a project cleans up everything in one shot via removeProjectStorage.

export function projectsRoot(): string {
  return path.join(app.getPath('userData'), 'projects');
}

export function projectDir(projectId: string): string {
  return path.join(projectsRoot(), projectId);
}

export function ensureProjectDir(projectId: string): string {
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function removeProjectStorage(projectId: string): Promise<void> {
  const dir = projectDir(projectId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.error('project-storage', `failed to remove ${dir}`, err);
  }
}
