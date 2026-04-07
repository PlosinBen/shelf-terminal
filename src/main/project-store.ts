import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { ProjectConfig } from '../shared/types';

function getConfigPath(): string {
  const configDir = path.join(app.getPath('userData'));
  return path.join(configDir, 'projects.json');
}

export function loadProjects(): ProjectConfig[] {
  const filePath = getConfigPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ProjectConfig[];
  } catch {
    return [];
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
