import { clipboard, shell } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { ExternalUrlIntentInput } from '@shared/external-url-intent';
import { log } from '@shared/logger';
import { getMainWindow } from './app-state';
import { ExternalUrlIntentGate } from './external-url-intent-gate';
import { openLink } from './link-open-intent';
import { LINK_OPEN } from '@shared/link-open-intent';

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

export async function requestExternalUrlIntent(input: ExternalUrlIntentInput | unknown) {
  // Compatibility adapter: login, BROWSER and protective navigation callers
  // explicitly retain their OS destination through the unified router.
  if (!input || typeof input !== 'object') return externalUrlIntentGate.request(input);
  const result = await openLink({ ...input, destination: LINK_OPEN.external }, {
    external: value => externalUrlIntentGate.request(value),
    web: () => { throw new Error('External request cannot open a Web tab'); },
    file: async () => { throw new Error('External request cannot preview a file'); },
  });
  if (result.kind !== 'opened' || !result.decision) throw new Error('External link decision unavailable');
  return result.decision;
}

if (process.env.SHELF_TEST_MODE === '1') {
  (globalThis as typeof globalThis & {
    __shelfTestRequestExternalUrlIntent?: typeof requestExternalUrlIntent;
  }).__shelfTestRequestExternalUrlIntent = requestExternalUrlIntent;
}
