import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { log } from '../shared/logger';
import type { ProjectConfig } from '../shared/types';

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
    return { ok: true, value: JSON.parse(raw) as ProjectConfig[] };
  } catch (err: any) {
    log.error('project-store', `failed to parse ${filePath}: ${err?.message ?? err}`);
    return { ok: false, error: 'parse', path: filePath, message: err?.message ?? String(err) };
  }
}

export function saveProjects(projects: ProjectConfig[]): void {
  const filePath = getConfigPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(projects, null, 2), 'utf-8');
}
