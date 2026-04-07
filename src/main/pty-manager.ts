import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import os from 'os';
import fs from 'fs';
import { IPC } from '../shared/ipc-channels';

const ptys = new Map<string, pty.IPty>();

function resolveShell(): string {
  // Try SHELL env, then common paths
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

export function spawnPty(
  tabId: string,
  cwd: string,
  win: BrowserWindow,
): void {
  const resolvedCwd = fs.existsSync(cwd) ? cwd : os.homedir();
  const shell = process.platform === 'win32' ? 'powershell.exe' : resolveShell();

  const p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
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
