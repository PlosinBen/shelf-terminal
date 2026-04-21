import * as pty from 'node-pty';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { FolderListResult } from '@shared/types';
import { log } from '@shared/logger';
import type { Connector, Shell, ExecResult } from '../types';
import { wrapPty } from '../wrap-pty';
import { getShellEnv, resolveShell } from '../shell-env';
import {
  REL_DIR, GITIGNORE_REL,
  normalizeCwd, assertSafeCwd, buildPaths, parseUploadPrefix,
} from '../file-utils';

export class LocalUnixConnector implements Connector {
  createShell(cwd: string): Shell {
    const resolvedCwd = fs.existsSync(cwd) ? cwd : os.homedir();
    const shell = resolveShell();
    log.info('connector', `local/unix spawn: shell=${shell} cwd=${resolvedCwd}`);
    const p = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: getShellEnv(),
    });
    return wrapPty(p);
  }

  isConnected(): Promise<boolean> {
    return Promise.resolve(true);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  exec(cwd: string, cmd: string): Promise<ExecResult> {
    const TIMEOUT_MS = 60_000;
    const MAX_BUFFER = 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      execFile('sh', ['-c', cmd], { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error: any, stdout, stderr) => {
        if (error) {
          // Node signals timeout via killed=true + SIGTERM; maxBuffer overflow
          // via code ERR_CHILD_PROCESS_STDIO_MAXBUFFER. The default error
          // message ("Command failed: sh -c …") hides the reason — translate.
          if (error.killed && error.signal === 'SIGTERM') {
            reject(new Error(`Command timed out after ${TIMEOUT_MS / 1000}s`));
            return;
          }
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new Error(`Command output exceeded ${MAX_BUFFER / 1024 / 1024}MB — narrow the query`));
            return;
          }
          reject(new Error(stderr || error.message));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  listDir(dirPath: string): Promise<FolderListResult> {
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

      return Promise.resolve({ path: resolved, entries });
    } catch (err) {
      return Promise.resolve({
        path: dirPath,
        entries: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  homePath(): Promise<string> {
    return Promise.resolve(os.homedir());
  }

  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string> {
    assertSafeCwd(cwd);
    const { remoteDir, remotePath } = buildPaths(cwd, filename);
    fs.mkdirSync(remoteDir, { recursive: true });
    ensureLocalGitignore(cwd);
    fs.writeFileSync(remotePath, buffer);
    return Promise.resolve(remotePath);
  }

  async cleanupSession(cwd: string, cutoffMs: number): Promise<number> {
    assertSafeCwd(cwd);
    const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;
    const entries = listLocalShelfDir(dir);
    const stale = entries.filter((name) => {
      const ts = parseUploadPrefix(name);
      return ts !== null && ts < cutoffMs;
    });
    if (stale.length === 0) return 0;

    let removed = 0;
    for (const name of stale) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed++;
      } catch (err: any) {
        log.debug('connector', `local rm failed for ${name}: ${err?.message ?? err}`);
      }
    }
    return removed;
  }

  async clearUploads(cwd: string): Promise<number> {
    assertSafeCwd(cwd);
    const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;
    const entries = listLocalShelfDir(dir);
    if (entries.length === 0) return 0;

    let removed = 0;
    for (const name of entries) {
      try {
        fs.rmSync(path.join(dir, name), { force: true, recursive: true });
        removed++;
      } catch (err: any) {
        log.debug('connector', `local clear rm failed for ${name}: ${err?.message ?? err}`);
      }
    }
    return removed;
  }
}

function listLocalShelfDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function ensureLocalGitignore(cwd: string): void {
  try {
    const gitignorePath = path.join(normalizeCwd(cwd), GITIGNORE_REL);
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n');
    }
  } catch (err: any) {
    log.debug('connector', `gitignore write skipped: ${err?.message ?? err}`);
  }
}
