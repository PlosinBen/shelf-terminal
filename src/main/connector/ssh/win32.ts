import * as pty from 'node-pty';
import { execFile } from 'child_process';
import os from 'os';
import type { FolderListResult } from '../../../shared/types';
import { log } from '../../../shared/logger';
import type { Connector, Shell } from '../types';
import { wrapPty } from '../wrap-pty';
import { shellEscape } from '../shell-env';
import { getKnownHostsPath } from '../../ssh-control';
import {
  assertSafeCwd, buildPaths, parseUploadPrefix, buildRemoteUploadCmd,
  spawnPipeWrite, listRemoteShelfDir, removeRemoteFiles,
} from '../file-utils';

/**
 * SSH connector for Windows — no ControlMaster support.
 * Each operation opens an independent SSH connection.
 */
export class SSHWin32Connector implements Connector {
  constructor(
    private host: string,
    private port: number,
    private user: string,
  ) {}

  private sshArgs(extraArgs: string[]): string[] {
    return [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
      '-o', 'ServerAliveInterval=30',
      '-p', String(this.port),
      `${this.user}@${this.host}`,
      ...extraArgs,
    ];
  }

  private sshExecArgs(extraArgs: string[]): string[] {
    return [
      '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
      '-o', 'ConnectTimeout=5',
      '-p', String(this.port),
      `${this.user}@${this.host}`,
      ...extraArgs,
    ];
  }

  createShell(cwd: string): Shell {
    const args = this.sshArgs([
      '-t',
      `cd ${shellEscape(cwd)} && exec $SHELL -l`,
    ]);
    log.info('connector', `ssh/win32 spawn: ${this.user}@${this.host}:${this.port} cwd=${cwd}`);
    const p = pty.spawn('ssh', args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    return wrapPty(p);
  }

  isConnected(): Promise<boolean> {
    // Without ControlMaster we attempt a quick SSH exec to check connectivity
    return new Promise((resolve) => {
      execFile('ssh', this.sshExecArgs(['echo ok']), { timeout: 5000 }, (error) => {
        resolve(!error);
      });
    });
  }

  connect(password?: string): Promise<void> {
    // Windows SSH doesn't use ControlMaster, so "connect" just verifies
    // reachability. Password auth happens at shell spawn time.
    if (!password) {
      return Promise.reject(new Error('SSH password required for first connection'));
    }

    log.info('connector', `ssh/win32 establishing connection: ${this.user}@${this.host}:${this.port}`);

    return new Promise((resolve, reject) => {
      const p = pty.spawn('ssh', [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
        '-p', String(this.port),
        `${this.user}@${this.host}`,
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
        if (!passwordSent && /password:|passphrase/i.test(output)) {
          passwordSent = true;
          p.write(password + '\n');
        }
        if (!settled && output.includes('__SHELF_AUTH_OK__')) {
          settled = true;
          clearTimeout(timeout);
          p.kill();
          resolve();
        }
      });

      p.onExit(() => {
        clearTimeout(timeout);
        if (settled) return;
        if (output.includes('__SHELF_AUTH_OK__')) {
          settled = true;
          resolve();
        } else {
          settled = true;
          if (/HOST IDENTIFICATION HAS CHANGED|host key.*has changed/i.test(output)) {
            const fingerprint = output.match(/key sent by the remote host is\s+(\S+)/)?.[1]
              ?? output.match(/ED25519 key fingerprint is\s+(\S+)/)?.[1]
              ?? 'unknown';
            reject(new Error(`HOST_KEY_CHANGED fingerprint:${fingerprint}`));
          } else {
            reject(new Error('SSH authentication failed'));
          }
        }
      });
    });
  }

  listDir(dirPath: string): Promise<FolderListResult> {
    log.debug('connector', `ssh/win32 listDir: ${this.user}@${this.host}:${this.port} path=${dirPath}`);
    return new Promise((resolve) => {
      const cmd = `ls -1 -p ${shellEscape(dirPath)} 2>/dev/null | grep '/$' | sed 's|/$||'`;
      execFile('ssh', this.sshExecArgs([cmd]), { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ path: dirPath, entries: [], error: stderr || error.message });
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
      execFile('ssh', this.sshExecArgs(['echo $HOME']), { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve(`/home/${this.user}`);
          return;
        }
        resolve(stdout.trim() || `/home/${this.user}`);
      });
    });
  }

  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string> {
    assertSafeCwd(cwd);
    const { remoteDir, remotePath } = buildPaths(cwd, filename);
    const cmd = buildRemoteUploadCmd(cwd, remoteDir, remotePath);
    return spawnPipeWrite(
      'ssh', this.sshExecArgs([cmd]), buffer, remotePath, 'ssh upload',
    );
  }

  async cleanupSession(cwd: string, cutoffMs: number): Promise<number> {
    assertSafeCwd(cwd);
    const entries = await listRemoteShelfDir(
      'ssh', (cmd) => this.sshExecArgs([cmd]), cwd, 'ssh',
    );
    const stale = entries.filter((name) => {
      const ts = parseUploadPrefix(name);
      return ts !== null && ts < cutoffMs;
    });
    if (stale.length === 0) return 0;
    await removeRemoteFiles('ssh', (cmd) => this.sshExecArgs([cmd]), cwd, stale, 'ssh');
    return stale.length;
  }

  async clearUploads(cwd: string): Promise<number> {
    assertSafeCwd(cwd);
    const entries = await listRemoteShelfDir(
      'ssh', (cmd) => this.sshExecArgs([cmd]), cwd, 'ssh',
    );
    if (entries.length === 0) return 0;
    await removeRemoteFiles('ssh', (cmd) => this.sshExecArgs([cmd]), cwd, entries, 'ssh');
    return entries.length;
  }
}
