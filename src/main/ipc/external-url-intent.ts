import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { externalUrlIntentGate } from '../external-url-intent';
import { requestExternalUrlIntent } from '../external-url-intent';

export function registerExternalUrlIntentHandlers(): void {
  ipcMain.handle(IPC.EXTERNAL_URL_INTENT_SUBMIT, (_event, payload: unknown) => (
    requestExternalUrlIntent(payload)
  ));
  ipcMain.handle(IPC.EXTERNAL_URL_INTENT_RESOLVE, async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid external URL decision payload');
    }
    const { requestId, decision } = payload as { requestId?: unknown; decision?: unknown };
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('Invalid external URL decision request id');
    }
    await externalUrlIntentGate.resolve(requestId, decision);
  });
}
