import { clipboard, shell } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { ExternalUrlIntentInput } from '@shared/external-url-intent';
import { log } from '@shared/logger';
import { getMainWindow } from './app-state';
import { ExternalUrlIntentGate } from './external-url-intent-gate';

export const externalUrlIntentGate = new ExternalUrlIntentGate({
  hasWindow: () => {
    const win = getMainWindow();
    return Boolean(win && !win.isDestroyed());
  },
  sendRequest: (request) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error('Renderer window is unavailable');
    win.webContents.send(IPC.EXTERNAL_URL_INTENT_REQUEST, request);
  },
  sendClose: (requestId) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error('Renderer window is unavailable');
    win.webContents.send(IPC.EXTERNAL_URL_INTENT_CLOSE, { requestId });
  },
  copyUrl: (url) => clipboard.writeText(url),
  openUrl: (url) => shell.openExternal(url),
  logError: (message) => log.error('external-url-intent', message),
});

export function requestExternalUrlIntent(input: ExternalUrlIntentInput | unknown) {
  return externalUrlIntentGate.request(input);
}
