import { BrowserWindow, Notification } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { Connection } from '@shared/types';
import type { Shell } from './connector/types';
import { createConnector } from './connector';
import { log } from '@shared/logger';
import { maybeScheduleCleanup } from './file-transfer';
import * as scrollback from './pm/scrollback-buffer';

const shells = new Map<string, Shell>();

// ── Idle detection for notifications ──
const IDLE_THRESHOLD_MS = 3000;    // 3s no output → idle
const MIN_ACTIVE_MS = 5000;        // must have been active for 5s+ to notify
interface ActivityState {
  firstDataTime: number;
  lastDataTime: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  userInput: boolean;
}
const activity = new Map<string, ActivityState>();
const mutedTabs = new Set<string>();

function clearActivity(tabId: string) {
  const state = activity.get(tabId);
  if (state?.idleTimer) clearTimeout(state.idleTimer);
  activity.delete(tabId);
}

export function spawnPty(
  projectId: string,
  tabId: string,
  cwd: string,
  connection: Connection,
  win: BrowserWindow,
  initScript?: string,
  tabCmd?: string,
): void {
  const connector = createConnector(connection);
  const shell = connector.createShell(cwd);

  shells.set(tabId, shell);

  // Fire-and-forget background cleanup for stale uploads from previous Shelf
  // sessions. Runs once per (project × process), 3s after first spawn so it
  // doesn't compete with shell startup or first paint.
  maybeScheduleCleanup(projectId, connection, cwd);

  if (initScript || tabCmd) {
    // Detect shell prompt readiness before sending initScript.
    // Modern shells (zsh, bash 4.4+, fish) enable bracketed paste mode
    // (\x1b[?2004h) when the line editor is ready for input — this is
    // the shell's own "I'm ready" signal, no timing guesswork needed.
    // After detecting readiness, wait for output idle + minimum 1s to ensure
    // all profile scripts (e.g. nvm) have finished loading.
    const spawnTime = Date.now();
    const MIN_WAIT_MS = 1000;
    let sent = false;
    let readyDetected = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      if (sent) return;
      sent = true;
      dispose.dispose();
      if (idleTimer) clearTimeout(idleTimer);
      if (initScript) shell.write(initScript + '\n');
      if (tabCmd) {
        setTimeout(() => shell.write(tabCmd + '\n'), initScript ? 200 : 0);
      }
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PTY_INIT_SENT, { tabId });
      }
    };
    const scheduleIdleSend = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const elapsed = Date.now() - spawnTime;
      const remainingWait = Math.max(0, MIN_WAIT_MS - elapsed);
      // Wait for output idle (500ms) or remaining minimum wait, whichever is longer
      idleTimer = setTimeout(send, Math.max(500, remainingWait));
    };
    const dispose = shell.onData((data) => {
      if (sent) return;
      if (!readyDetected && data.includes('\x1b[?2004h')) {
        readyDetected = true;
        scheduleIdleSend();
        return;
      }
      // After ready detected, reset idle timer on each output
      if (readyDetected) {
        scheduleIdleSend();
        return;
      }
      // Fallback: debounce for shells without bracketed paste
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(send, 1500);
    });
    setTimeout(send, 10000);
  }

  shell.onData((data) => {
    scrollback.append(tabId, data);

    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_DATA, { tabId, data });
    }

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
      if (duration >= MIN_ACTIVE_MS && state!.userInput && !mutedTabs.has(tabId) && !win.isDestroyed() && !win.isFocused()) {
        new Notification({
          title: 'Shelf Terminal',
          body: 'Command finished',
        }).show();
      }
      state!.firstDataTime = Date.now();
      state!.idleTimer = null;
      state!.userInput = false;
    }, IDLE_THRESHOLD_MS);
  });

  shell.onExit((exitCode) => {
    log.info('pty', `exit: tabId=${tabId} exitCode=${exitCode}`);
    clearActivity(tabId);
    shells.delete(tabId);
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PTY_EXIT, { tabId, exitCode });
    }
  });
}

export function setMuted(tabId: string, muted: boolean) {
  if (muted) {
    mutedTabs.add(tabId);
  } else {
    mutedTabs.delete(tabId);
  }
}

export function writePty(tabId: string, data: string) {
  const state = activity.get(tabId);
  if (state) state.userInput = true;
  shells.get(tabId)?.write(data);
}

export function resizePty(tabId: string, cols: number, rows: number) {
  shells.get(tabId)?.resize(cols, rows);
}

export function killPty(tabId: string) {
  const s = shells.get(tabId);
  if (s) {
    s.kill();
    clearActivity(tabId);
    scrollback.remove(tabId);
    shells.delete(tabId);
  }
}

export function killAllPtys() {
  for (const [tabId, s] of shells) {
    clearActivity(tabId);
    s.kill();
    shells.delete(tabId);
  }
  scrollback.clear();
}
