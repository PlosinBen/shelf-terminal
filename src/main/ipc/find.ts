import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { IPC } from '@shared/ipc-channels';

/**
 * In-page find for DOM-based tabs (agent / web). Terminal tabs search through
 * xterm's SearchAddon in the renderer; agent/web tabs are plain DOM with no
 * addon, so the renderer drives Chromium's native findInPage here and we relay
 * the 'found-in-page' result (active ordinal + total matches) back for the
 * SearchBar's match counter.
 */
export function registerFindHandlers(): void {
  // One 'found-in-page' listener per webContents (survives window recreation on
  // macOS — each new BrowserWindow has a fresh sender).
  const forwarderBound = new WeakSet<WebContents>();

  ipcMain.on(
    IPC.WINDOW_FIND,
    (event, payload: { text: string; forward: boolean; findNext: boolean }) => {
      const wc = event.sender;
      if (!forwarderBound.has(wc)) {
        forwarderBound.add(wc);
        wc.on('found-in-page', (_e, result) => {
          if (wc.isDestroyed()) return;
          wc.send(IPC.WINDOW_FIND_RESULT, {
            activeMatchOrdinal: result.activeMatchOrdinal,
            matches: result.matches,
            finalUpdate: result.finalUpdate,
          });
        });
      }
      if (!payload.text) return;
      wc.findInPage(payload.text, { forward: payload.forward, findNext: payload.findNext });
    },
  );

  ipcMain.on(IPC.WINDOW_STOP_FIND, (event) => {
    if (event.sender.isDestroyed()) return;
    event.sender.stopFindInPage('clearSelection');
  });
}
