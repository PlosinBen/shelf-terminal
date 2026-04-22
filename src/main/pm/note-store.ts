import path from 'path';
import fs from 'fs';
import { app } from 'electron';

function notesDir(): string {
  return path.join(app.getPath('userData'), 'pm-notes');
}

function notePath(projectId: string): string {
  return path.join(notesDir(), `${projectId}.md`);
}

export function readNote(projectId: string): string {
  const p = notePath(projectId);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

export function writeNote(projectId: string, content: string): void {
  const dir = notesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(notePath(projectId), content, 'utf-8');
}
