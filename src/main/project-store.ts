import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { log } from '@shared/logger';
import type { ProjectConfig } from '@shared/types';

export type LoadError = 'parse' | 'permission' | 'read';

export type LoadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LoadError; path: string; message: string };

function getConfigPath(): string {
  const configDir = path.join(app.getPath('userData'));
  return path.join(configDir, 'projects.json');
}

export function loadProjects(): LoadResult<ProjectConfig[]> {
  const filePath = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      log.info('project-store', `no projects.json at ${filePath}, starting empty`);
      return { ok: true, value: [] };
    }
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      log.error('project-store', `permission denied reading ${filePath}: ${err?.message ?? err}`);
      return { ok: false, error: 'permission', path: filePath, message: err?.message ?? String(err) };
    }
    log.error('project-store', `failed to read ${filePath}: ${err?.message ?? err}`);
    return { ok: false, error: 'read', path: filePath, message: err?.message ?? String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as ProjectConfig[];
    return { ok: true, value: parsed };
  } catch (err: any) {
    log.error('project-store', `failed to parse ${filePath}: ${err?.message ?? err}`);
    return { ok: false, error: 'parse', path: filePath, message: err?.message ?? String(err) };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function timestampSuffix(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Guard against accidental data loss: if we're about to overwrite a file
// that has real projects with an empty list, preserve the original as a
// backup. See the 4/16 incident where projects.json got wiped to [].
function maybeBackupBeforeEmptyWrite(filePath: string, nextProjects: ProjectConfig[]): void {
  if (nextProjects.length > 0) return;
  if (!fs.existsSync(filePath)) return;
  let existing: unknown;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return;
  }
  if (!Array.isArray(existing) || existing.length === 0) return;
  const backupPath = `${filePath}.backup.${timestampSuffix()}`;
  try {
    fs.copyFileSync(filePath, backupPath);
    log.error(
      'project-store',
      `about to overwrite ${existing.length} project(s) with []; backed up to ${backupPath}`,
    );
  } catch (err: any) {
    log.error('project-store', `failed to back up before empty write: ${err?.message ?? err}`);
  }
}

export function saveProjects(projects: ProjectConfig[]): void {
  const filePath = getConfigPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  maybeBackupBeforeEmptyWrite(filePath, projects);
  fs.writeFileSync(filePath, JSON.stringify(projects, null, 2), 'utf-8');
}
