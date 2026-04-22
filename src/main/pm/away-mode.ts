import { BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';

let awayMode = false;
let win: BrowserWindow | null = null;

export function initAwayMode(mainWindow: BrowserWindow): void {
  win = mainWindow;
}

export function isAwayMode(): boolean {
  return awayMode;
}

export function setAwayMode(on: boolean): void {
  awayMode = on;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.PM_AWAY_MODE, awayMode);
  }
}
