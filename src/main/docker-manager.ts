import { execFile } from 'child_process';
import type { FolderListResult } from '../shared/types';
import { log } from '../shared/logger';

const DOCKER = '/usr/local/bin/docker';

function dockerBin(): string {
  return process.env.DOCKER_PATH || DOCKER;
}

export function dockerListContainers(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(dockerBin(), ['ps', '--format', '{{.Names}}'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        log.error('docker', `listContainers: ${err.message}`);
        resolve([]);
        return;
      }
      const names = stdout.trim().split('\n').filter((n) => n.length > 0);
      resolve(names);
    });
  });
}

export function dockerIsRunning(container: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(dockerBin(), ['inspect', '-f', '{{.State.Running}}', container], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === 'true');
    });
  });
}

export function dockerListDir(container: string, dirPath: string): Promise<FolderListResult> {
  return new Promise((resolve) => {
    const cmd = `ls -1 -p ${shellEscape(dirPath)} 2>/dev/null | grep '/$' | sed 's|/$||'`;
    execFile(dockerBin(), ['exec', container, 'sh', '-c', cmd], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ path: dirPath, entries: [], error: stderr || err.message });
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
    });
  });
}

export function dockerHomePath(container: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(dockerBin(), ['exec', container, 'sh', '-c', 'echo $HOME'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '/' : (stdout.trim() || '/'));
    });
  });
}

export function dockerCopyImage(localPath: string, container: string, remotePath: string): Promise<string> {
  const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
  return new Promise((resolve, reject) => {
    // Ensure remote directory exists
    execFile(dockerBin(), ['exec', container, 'mkdir', '-p', remoteDir], { timeout: 5000 }, () => {
      // Copy file into container
      execFile(dockerBin(), ['cp', localPath, `${container}:${remotePath}`], { timeout: 30000 }, (err) => {
        if (err) {
          reject(new Error(`docker cp failed: ${err.message}`));
        } else {
          resolve(remotePath);
        }
      });
    });
  });
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
