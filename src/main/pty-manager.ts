import * as pty from 'node-pty';
import { BrowserWindow, Notification } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { IPC } from '../shared/ipc-channels';
import { getControlPath } from './ssh-control';
import type { Connection } from '../shared/types';

const ptys = new Map<string, pty.IPty>();

// ── Idle detection for notifications ──
const IDLE_THRESHOLD_MS = 3000;    // 3s no output → idle
const MIN_ACTIVE_MS = 5000;        // must have been active for 5s+ to notify
interface ActivityState {
  firstDataTime: number;
  lastDataTime: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}
const activity = new Map<string, ActivityState>();

function clearActivity(tabId: string) {
  const state = activity.get(tabId);
  if (state?.idleTimer) clearTimeout(state.idleTimer);
  activity.delete(tabId);
}

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
  initScript?: string,
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
      args = ['-d', connection.distro, '--', 'bash', '-l', '-c', `cd ${shellEscape(cwd)} && exec $SHELL -l`];
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

  if (initScript) {
    // Small delay to let shell initialize before sending init script
    setTimeout(() => {
      p.write(initScript + '\n');
    }, 300);
  }

  p.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_DATA, { tabId, data });
    }

    // Track activity for idle notification
    const now = Date.now();
    let state = activity.get(tabId);
    if (!state) {
      state = { firstDataTime: now, lastDataTime: now, idleTimer: null };
      activity.set(tabId, state);
    }
    state.lastDataTime = now;

    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      const duration = state!.lastDataTime - state!.firstDataTime;
      if (duration >= MIN_ACTIVE_MS && !win.isDestroyed() && !win.isFocused()) {
        new Notification({
          title: 'Shelf Terminal',
          body: 'Command finished',
        }).show();
      }
      // Reset for next command
      state!.firstDataTime = Date.now();
      state!.idleTimer = null;
    }, IDLE_THRESHOLD_MS);
  });

  p.onExit(({ exitCode }) => {
    clearActivity(tabId);
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
    clearActivity(tabId);
    ptys.delete(tabId);
  }
}

export function killAllPtys() {
  for (const [tabId, p] of ptys) {
    clearActivity(tabId);
    p.kill();
    ptys.delete(tabId);
  }
}
