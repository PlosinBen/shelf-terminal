import { BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';

let awayMode = false;
let win: BrowserWindow | null = null;
const listeners = new Set<(on: boolean) => void>();

export function initAwayMode(mainWindow: BrowserWindow): void {
  win = mainWindow;
}

export function isAwayMode(): boolean {
  return awayMode;
}

/** Subscribe to away-mode flips. Used by the web-permission router to re-deliver
 *  pending prompts to Telegram when the user steps away. Returns unsubscribe. */
export function onAwayModeChange(cb: (on: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setAwayMode(on: boolean): void {
  if (awayMode === on) return;
  awayMode = on;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.PM_AWAY_MODE, awayMode);
  }
  for (const cb of listeners) cb(on);
}
