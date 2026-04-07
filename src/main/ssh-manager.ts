import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import type { FolderListResult } from '../shared/types';

function getControlDir(): string {
  const dir = path.join(os.tmpdir(), 'shelf-ssh-control');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getControlPath(host: string, port: number, user: string): string {
  return path.join(getControlDir(), `${user}@${host}:${port}`);
}

export function sshListDir(
  host: string,
  port: number,
  user: string,
  dirPath: string,
): Promise<FolderListResult> {
  return new Promise((resolve) => {
    const controlPath = getControlPath(host, port, user);
    const cmd = `ls -1 -p ${shellEscape(dirPath)} 2>/dev/null | grep '/$' | sed 's|/$||'`;

    execFile(
      'ssh',
      [
        '-o', `ControlMaster=auto`,
        '-o', `ControlPath=${controlPath}`,
        '-o', `ControlPersist=600`,
        '-o', 'ConnectTimeout=5',
        '-p', String(port),
        `${user}@${host}`,
        cmd,
      ],
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            path: dirPath,
            entries: [],
            error: stderr || error.message,
          });
          return;
        }

        const entries = stdout
          .trim()
          .split('\n')
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

export function sshGetHomePath(
  host: string,
  port: number,
  user: string,
): Promise<string> {
  return new Promise((resolve) => {
    const controlPath = getControlPath(host, port, user);

    execFile(
      'ssh',
      [
        '-o', `ControlMaster=auto`,
        '-o', `ControlPath=${controlPath}`,
        '-o', `ControlPersist=600`,
        '-o', 'ConnectTimeout=5',
        '-p', String(port),
        `${user}@${host}`,
        'echo $HOME',
      ],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          resolve(`/home/${user}`);
          return;
        }
        resolve(stdout.trim() || `/home/${user}`);
      },
    );
  });
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
