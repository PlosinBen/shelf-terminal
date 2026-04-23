import * as pty from 'node-pty';
import { execFile } from 'child_process';
import os from 'os';
import type { FolderListResult } from '@shared/types';
import { log } from '@shared/logger';
import type { Connector, Shell, ExecResult } from './types';
import { wrapPty } from './wrap-pty';
import { getShellEnv, shellEscape } from './shell-env';
import {
  assertSafeCwd, buildPaths, parseUploadPrefix, buildRemoteUploadCmd,
  spawnPipeWrite, listRemoteShelfDir, removeRemoteFiles,
} from './file-utils';


export class DockerConnector implements Connector {
  constructor(private container: string) {}

  private dockerExecArgs(cmd: string): string[] {
    return ['exec', this.container, 'sh', '-c', cmd];
  }

  createShell(cwd: string): Shell {
    const bin = 'docker';
    const args = ['exec', '-it', this.container, 'sh', '-c', `cd ${shellEscape(cwd)} && exec \${SHELL:-sh}`];
    log.info('connector', `docker spawn: container=${this.container} cwd=${cwd} bin=${bin}`);
    const p = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: getShellEnv(),
    });
    return wrapPty(p);
  }

  exec(cwd: string, cmd: string): Promise<ExecResult> {
    const remoteCmd = `cd ${shellEscape(cwd)} && ${cmd}`;
    return new Promise((resolve, reject) => {
      execFile('docker', this.dockerExecArgs(remoteCmd), { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  isConnected(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('docker', ['inspect', '-f', '{{.State.Running}}', this.container], { timeout: 5000 }, (err, stdout) => {
        resolve(!err && stdout.trim() === 'true');
      });
    });
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  listDir(dirPath: string): Promise<FolderListResult> {
    return new Promise((resolve) => {
      const cmd = `ls -1 -p ${shellEscape(dirPath)} 2>/dev/null | grep '/$' | sed 's|/$||'`;
      execFile('docker', ['exec', this.container, 'sh', '-c', cmd], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ path: dirPath, entries: [], error: stderr || err.message });
          return;
        }
        const entries = stdout.trim().split('\n')
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

  homePath(): Promise<string> {
    return new Promise((resolve) => {
      execFile('docker', ['exec', this.container, 'sh', '-c', 'echo $HOME'], { timeout: 5000 }, (err, stdout) => {
        resolve(err ? '/' : (stdout.trim() || '/'));
      });
    });
  }

  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string> {
    assertSafeCwd(cwd);
    const { remoteDir, remotePath } = buildPaths(cwd, filename);
    const bin = 'docker';
    const cmd = buildRemoteUploadCmd(cwd, remoteDir, remotePath);
    return spawnPipeWrite(
      bin, ['exec', '-i', this.container, 'sh', '-c', cmd],
      buffer, remotePath, 'docker upload',
    );
  }

  async cleanupSession(cwd: string, cutoffMs: number): Promise<number> {
    assertSafeCwd(cwd);
    const bin = 'docker';
    const entries = await listRemoteShelfDir(
      bin, (cmd) => this.dockerExecArgs(cmd), cwd, 'docker',
    );
    const stale = entries.filter((name) => {
      const ts = parseUploadPrefix(name);
      return ts !== null && ts < cutoffMs;
    });
    if (stale.length === 0) return 0;
    await removeRemoteFiles(bin, (cmd) => this.dockerExecArgs(cmd), cwd, stale, 'docker');
    return stale.length;
  }

  async clearUploads(cwd: string): Promise<number> {
    assertSafeCwd(cwd);
    const bin = 'docker';
    const entries = await listRemoteShelfDir(
      bin, (cmd) => this.dockerExecArgs(cmd), cwd, 'docker',
    );
    if (entries.length === 0) return 0;
    await removeRemoteFiles(bin, (cmd) => this.dockerExecArgs(cmd), cwd, entries, 'docker');
    return entries.length;
  }
}

/** List running Docker containers. Standalone export for FolderPicker UI. */
export function listDockerContainers(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--format', '{{.Names}}'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        log.error('connector', `docker listContainers: ${err.message}`);
        resolve([]);
        return;
      }
      resolve(stdout.trim().split('\n').filter((n) => n.length > 0));
    });
  });
}
