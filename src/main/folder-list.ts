import fs from 'fs';
import path from 'path';
import os from 'os';

export interface FolderListResult {
  path: string;
  entries: string[];
  error?: string;
}

export function listDirectory(dirPath: string): FolderListResult {
  try {
    const resolved = dirPath.startsWith('~')
      ? path.join(os.homedir(), dirPath.slice(1))
      : path.resolve(dirPath);

    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => {
        const aDot = a.startsWith('.');
        const bDot = b.startsWith('.');
        if (aDot !== bDot) return aDot ? 1 : -1;
        return a.localeCompare(b);
      });

    return { path: resolved, entries };
  } catch (err) {
    return {
      path: dirPath,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getHomePath(): string {
  return os.homedir();
}
