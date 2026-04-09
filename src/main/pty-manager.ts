import * as pty from 'node-pty';
import { BrowserWindow, Notification } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { IPC } from '../shared/ipc-channels';
import { getControlPath } from './ssh-control';
import type { Connection } from '../shared/types';
import { log } from '../shared/logger';

const ptys = new Map<string, pty.IPty>();

// ── Idle detection for notifications ──
const IDLE_THRESHOLD_MS = 3000;    // 3s no output → idle
const MIN_ACTIVE_MS = 5000;        // must have been active for 5s+ to notify
interface ActivityState {
  firstDataTime: number;
  lastDataTime: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  userInput: boolean;  // true after user types; reset after notification
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
  tabCmd?: string,
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
      args = ['-d', connection.distro, '--', 'sh', '-c', `cd ${shellEscape(cwd)} && exec $SHELL`];
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

  log.info('pty', `spawn: shell=${shell} args=${JSON.stringify(args)} cwd=${spawnCwd} connection=${connection.type}`);
  if (initScript) log.debug('pty', `initScript: ${initScript}`);

  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: spawnCwd,
    env: process.env as Record<string, string>,
  });

  ptys.set(tabId, p);

  if (initScript || tabCmd) {
    // Detect shell prompt readiness before sending initScript.
    // Modern shells (zsh, bash 4.4+, fish) enable bracketed paste mode
    // (\x1b[?2004h) when the line editor is ready for input — this is
    // the shell's own "I'm ready" signal, no timing guesswork needed.
    // Fallback: debounce on output idle for shells without bracketed paste.
    let sent = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      if (sent) return;
      sent = true;
      dispose.dispose();
      if (debounce) clearTimeout(debounce);
      if (initScript) p.write(initScript + '\n');
      if (tabCmd) {
        setTimeout(() => p.write(tabCmd + '\n'), initScript ? 200 : 0);
      }
    };
    const dispose = p.onData((data) => {
      if (sent) return;
      // Bracketed paste enable = line editor ready
      if (data.includes('\x1b[?2004h')) {
        send();
        return;
      }
      // Fallback: debounce for shells without bracketed paste
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(send, 500);
    });
    // Hard fallback for edge cases (e.g. SSH key prompt, no output at all)
    setTimeout(send, 10000);
  }

  p.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_DATA, { tabId, data });
    }

    // Track activity for idle notification
    const now = Date.now();
    let state = activity.get(tabId);
    if (!state) {
      state = { firstDataTime: now, lastDataTime: now, idleTimer: null, userInput: false };
      activity.set(tabId, state);
    }
    state.lastDataTime = now;

    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      const duration = state!.lastDataTime - state!.firstDataTime;
      if (duration >= MIN_ACTIVE_MS && state!.userInput && !win.isDestroyed() && !win.isFocused()) {
        new Notification({
          title: 'Shelf Terminal',
          body: 'Command finished',
        }).show();
      }
      // Reset for next command
      state!.firstDataTime = Date.now();
      state!.idleTimer = null;
      state!.userInput = false;
    }, IDLE_THRESHOLD_MS);
  });

  p.onExit(({ exitCode }) => {
    log.info('pty', `exit: tabId=${tabId} exitCode=${exitCode}`);
    clearActivity(tabId);
    ptys.delete(tabId);
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_EXIT, { tabId, exitCode });
    }
  });
}

export function writePty(tabId: string, data: string) {
  // Mark as user-initiated so idle notification fires after this command
  const state = activity.get(tabId);
  if (state) state.userInput = true;
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
