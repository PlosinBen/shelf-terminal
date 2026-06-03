import { BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';

// PM Active = the telegram-listener master switch (Phase A). Holds the runtime
// on/off state and mirrors it to the renderer. Orchestration (start/stop
// telegram, persist, cascade Away off) lives in the wiring layer (ipc/pm.ts),
// NOT here — this module is a pure state holder + sync, mirroring away-mode.ts.

let pmActive = false;
let win: BrowserWindow | null = null;

export function initPmActive(mainWindow: BrowserWindow): void {
  win = mainWindow;
}

export function isPmActive(): boolean {
  return pmActive;
}

/** Set runtime state + mirror to renderer. Does NOT start/stop telegram or
 *  persist — callers in the wiring layer handle those side effects. */
export function setPmActiveState(on: boolean): void {
  pmActive = on;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.PM_ACTIVE, pmActive);
  }
}
