import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { IPC } from '../shared/ipc-channels';
import type { Connection } from '../shared/types';

const ptys = new Map<string, pty.IPty>();

function resolveShell(): string {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '/bin/sh';
}

// SSH ControlMaster socket directory
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

function buildSSHArgs(host: string, port: number, user: string, cwd: string): string[] {
  const controlPath = getControlPath(host, port, user);
  return [
    '-o', `ControlMaster=auto`,
    '-o', `ControlPath=${controlPath}`,
    '-o', `ControlPersist=600`,
    '-o', 'ServerAliveInterval=30',
    '-p', String(port),
    `${user}@${host}`,
    '-t',
    `cd ${shellEscape(cwd)} && exec $SHELL -l`,
  ];
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function spawnPty(
  tabId: string,
  cwd: string,
  connection: Connection,
  win: BrowserWindow,
): void {
  let shell: string;
  let args: string[];
  let spawnCwd: string;

  switch (connection.type) {
    case 'ssh': {
      shell = 'ssh';
      args = buildSSHArgs(connection.host, connection.port, connection.user, cwd);
      spawnCwd = os.homedir();
      break;
    }
    case 'wsl': {
      shell = 'wsl.exe';
      args = ['-d', connection.distro, '--cd', cwd];
      spawnCwd = os.homedir();
      break;
    }
    default: {
      const resolvedCwd = fs.existsSync(cwd) ? cwd : os.homedir();
      shell = process.platform === 'win32' ? 'powershell.exe' : resolveShell();
      args = [];
      spawnCwd = resolvedCwd;
      break;
    }
  }

  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: spawnCwd,
    env: process.env as Record<string, string>,
  });

  ptys.set(tabId, p);

  p.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_DATA, { tabId, data });
    }
  });

  p.onExit(({ exitCode }) => {
    ptys.delete(tabId);
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_EXIT, { tabId, exitCode });
    }
  });
}

export function writePty(tabId: string, data: string) {
  ptys.get(tabId)?.write(data);
}

export function resizePty(tabId: string, cols: number, rows: number) {
  ptys.get(tabId)?.resize(cols, rows);
}

export function killPty(tabId: string) {
  const p = ptys.get(tabId);
  if (p) {
    p.kill();
    ptys.delete(tabId);
  }
}

export function killAllPtys() {
  for (const [tabId, p] of ptys) {
    p.kill();
    ptys.delete(tabId);
  }
}
