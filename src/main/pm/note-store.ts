import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { ensureProjectDir, projectDir } from '../project-storage';

function notePath(projectId: string): string {
  return path.join(projectDir(projectId), 'pm-note.md');
}

export function readNote(projectId: string): string {
  try {
    return fs.readFileSync(notePath(projectId), 'utf-8');
  } catch {
    return '';
  }
}

export function writeNote(projectId: string, content: string): void {
  ensureProjectDir(projectId);
  fs.writeFileSync(notePath(projectId), content, 'utf-8');
}

function globalNotePath(): string {
  return path.join(app.getPath('userData'), 'pm-global-note.md');
}

export function readGlobalNote(): string {
  try {
    return fs.readFileSync(globalNotePath(), 'utf-8');
  } catch {
    return '';
  }
}

export function writeGlobalNote(content: string): void {
  fs.writeFileSync(globalNotePath(), content, 'utf-8');
}
