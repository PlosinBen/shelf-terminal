import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, setMuted } from '../pty-manager';
import { getMainWindow } from '../app-state';
import { resolveProjectEnv } from '../project-env';
import type { PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload } from '@shared/types';

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.PTY_SPAWN, (_event, payload: PtySpawnPayload) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Resolve the project's injected env in MAIN — never sent from the renderer
      // (secret values must never reach it). Plain now; + decrypted secrets later.
      const env = resolveProjectEnv(payload.projectId);
      spawnPty(payload.projectId, payload.tabId, payload.cwd, payload.connection, mainWindow, payload.initScript, payload.tabCmd, env);
    }
  });

  ipcMain.handle(IPC.PTY_KILL, (_event, payload: PtyKillPayload) => {
    killPty(payload.tabId);
  });

  // Renderer → Main (send, fire-and-forget)
  ipcMain.on(IPC.PTY_INPUT, (_event, payload: PtyInputPayload) => {
    writePty(payload.tabId, payload.data);
  });

  ipcMain.on(IPC.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
    resizePty(payload.tabId, payload.cols, payload.rows);
  });

  ipcMain.on(IPC.PTY_MUTE, (_event, payload: { tabId: string; muted: boolean }) => {
    setMuted(payload.tabId, payload.muted);
  });
}
