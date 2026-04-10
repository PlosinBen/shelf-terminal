import { execFile } from 'child_process';
import * as pty from 'node-pty';
import type { FolderListResult } from '../shared/types';
import { getControlPath } from './ssh-control';
import { checkConnection } from './ssh-control';
import { log } from '../shared/logger';

/**
 * Establish ControlMaster connection using password auth via pty.
 * After this succeeds, all subsequent SSH operations use the socket.
 */
export function sshEstablishConnection(
  host: string,
  port: number,
  user: string,
  password: string,
): Promise<void> {
  if (checkConnection(host, port, user)) {
    return Promise.resolve();
  }

  log.info('ssh', `establishing connection: ${user}@${host}:${port}`);
  const controlPath = getControlPath(host, port, user);

  return new Promise((resolve, reject) => {
    const p = pty.spawn('ssh', [
      '-o', `ControlMaster=auto`,
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=600`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(port),
      `${user}@${host}`,
      'echo __SHELF_AUTH_OK__',
    ], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });

    let output = '';
    let passwordSent = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.kill();
      reject(new Error('SSH connection timeout'));
    }, 15000);

    p.onData((data) => {
      output += data;
      // Detect password prompt
      if (!passwordSent && /password:|passphrase/i.test(output)) {
        passwordSent = true;
        p.write(password + '\n');
      }
      // Detect success
      if (!settled && output.includes('__SHELF_AUTH_OK__')) {
        settled = true;
        clearTimeout(timeout);
        p.kill();
        resolve();
      }
    });

    p.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (settled) return;
      // Check output one more time — onData may have buffered the success marker
      if (output.includes('__SHELF_AUTH_OK__')) {
        settled = true;
        resolve();
      } else {
        settled = true;
        reject(new Error('SSH authentication failed'));
      }
    });
  });
}

export function sshListDir(
  host: string,
  port: number,
  user: string,
  dirPath: string,
): Promise<FolderListResult> {
  log.debug('ssh', `listDir: ${user}@${host}:${port} path=${dirPath}`);
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
