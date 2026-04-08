import { execFile } from 'child_process';
import type { FolderListResult } from '../shared/types';
import { log } from '../shared/logger';

export function wslListDir(distro: string, dirPath: string): Promise<FolderListResult> {
  log.debug('wsl', `listDir: distro=${distro} path=${dirPath}`);
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'ls', '-1', '-p', dirPath],
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ path: dirPath, entries: [], error: stderr || error.message });
          return;
        }

        const entries = stdout
          .trim()
          .split('\n')
          .filter((e) => e.endsWith('/'))
          .map((e) => e.replace(/\/$/, ''))
          .filter((e) => e.length > 0)
          .sort((a, b) => {
            const aDot = a.startsWith('.');
            const bDot = b.startsWith('.');
            if (aDot !== bDot) return aDot ? 1 : -1;
            return a.localeCompare(b);
          });

        resolve({ path: dirPath, entries });
      },
    );
  });
}

export function wslHomePath(distro: string): Promise<string> {
  log.debug('wsl', `homePath: distro=${distro}`);
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'echo', '$HOME'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve('/home');
          return;
        }
        resolve(stdout.trim() || '/home');
      },
    );
  });
}
