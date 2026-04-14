import * as pty from 'node-pty';
import { execFile } from 'child_process';
import os from 'os';
import type { FolderListResult } from '@shared/types';
import { log } from '@shared/logger';
import type { Connector, Shell } from './types';
import { wrapPty } from './wrap-pty';
import { shellEscape } from './shell-env';
import {
  assertSafeCwd, buildPaths, parseUploadPrefix, buildRemoteUploadCmd,
  spawnPipeWrite, listRemoteShelfDir, removeRemoteFiles,
} from './file-utils';

export class WSLConnector implements Connector {
  constructor(private distro: string) {}

  private wslExecArgs(cmd: string): string[] {
    return ['-d', this.distro, '--', 'sh', '-c', cmd];
  }

  createShell(cwd: string): Shell {
    const args = ['-d', this.distro, '--', 'sh', '-c', `cd ${shellEscape(cwd)} && exec $SHELL`];
    log.info('connector', `wsl spawn: distro=${this.distro} cwd=${cwd}`);
    const p = pty.spawn('wsl.exe', args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    return wrapPty(p);
  }

  isConnected(): Promise<boolean> {
    return Promise.resolve(true);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  listDir(dirPath: string): Promise<FolderListResult> {
    log.debug('connector', `wsl listDir: distro=${this.distro} path=${dirPath}`);
    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        ['-d', this.distro, '--', 'ls', '-1', '-p', dirPath],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ path: dirPath, entries: [], error: stderr || error.message });
            return;
          }
          const entries = stdout.trim().split('\n')
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

  homePath(): Promise<string> {
    log.debug('connector', `wsl homePath: distro=${this.distro}`);
    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        ['-d', this.distro, '--', 'echo', '$HOME'],
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

  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string> {
    assertSafeCwd(cwd);
    const { remoteDir, remotePath } = buildPaths(cwd, filename);
    const cmd = buildRemoteUploadCmd(cwd, remoteDir, remotePath);
    return spawnPipeWrite(
      'wsl.exe', this.wslExecArgs(cmd), buffer, remotePath, 'wsl upload',
    );
  }

  async cleanupSession(cwd: string, cutoffMs: number): Promise<number> {
    assertSafeCwd(cwd);
    const entries = await listRemoteShelfDir(
      'wsl.exe', (cmd) => this.wslExecArgs(cmd), cwd, 'wsl',
    );
    const stale = entries.filter((name) => {
      const ts = parseUploadPrefix(name);
      return ts !== null && ts < cutoffMs;
    });
    if (stale.length === 0) return 0;
    await removeRemoteFiles('wsl.exe', (cmd) => this.wslExecArgs(cmd), cwd, stale, 'wsl');
    return stale.length;
  }

  async clearUploads(cwd: string): Promise<number> {
    assertSafeCwd(cwd);
    const entries = await listRemoteShelfDir(
      'wsl.exe', (cmd) => this.wslExecArgs(cmd), cwd, 'wsl',
    );
    if (entries.length === 0) return 0;
    await removeRemoteFiles('wsl.exe', (cmd) => this.wslExecArgs(cmd), cwd, entries, 'wsl');
    return entries.length;
  }
}

/** List installed WSL distros. Standalone export for FolderPicker UI. */
export function listWSLDistros(): Promise<string[]> {
  log.debug('connector', 'wsl listDistros');
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-q'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const distros = stdout
          .replace(/\0/g, '')
          .trim()
          .split('\n')
          .map((d) => d.trim())
          .filter((d) => d.length > 0);
        resolve(distros);
      },
    );
  });
}
