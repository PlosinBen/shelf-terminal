import { ipcMain } from 'electron';
import { TERMINAL_STARTUP_LOG_TAG } from '../terminal-init-session';
import { log } from '@shared/logger';
import { IPC } from '@shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, setMuted } from '../pty-manager';
import { getMainWindow } from '../app-state';
import { resolveProjectEnv } from '../project-env';
import type { PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload } from '@shared/types';
import { createConnector } from '../connector';
import { ensureExternalUrlLauncher } from '../external-url-launcher';

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.PTY_SPAWN, async (_event, payload: PtySpawnPayload) => {
    const started = Date.now();
    const context = `project=${payload.projectId} tab=${payload.tabId} connection=${payload.connection.type}`;
    let stage = 'request';
    const trace = (next: string) => {
      stage = next;
      log.info(TERMINAL_STARTUP_LOG_TAG, `${context} stage=${stage} elapsedMs=${Date.now() - started}`);
    };
    trace(stage);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      try {
        trace('environment:start');
        // Resolve the project's injected env in MAIN — never sent from the renderer
        // (secret values must never reach it). Plain now; + decrypted secrets later.
        const env = resolveProjectEnv(payload.projectId);
        trace('environment:complete');
        trace('launcher:start');
        const launcher = await ensureExternalUrlLauncher(
          createConnector(payload.connection),
          payload.connection,
          undefined,
          (step) => trace(`launcher:${step}`),
        );
        trace('launcher:complete');
        trace('spawn:start');
        await spawnPty(
          payload.projectId,
          payload.tabId,
          payload.cwd,
          payload.connection,
          mainWindow,
          payload.initScript,
          payload.tabCmd,
          env,
          { BROWSER: launcher },
        );
        trace('spawn:returned');
      } catch (error) {
        // Exec errors can contain full commands/env; record only the failed boundary.
        log.error(TERMINAL_STARTUP_LOG_TAG, `${context} stage=${stage} failed elapsedMs=${Date.now() - started}`);
        throw error;
      }
    } else {
      log.warn(TERMINAL_STARTUP_LOG_TAG, `${context} skipped=no-main-window`);
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
