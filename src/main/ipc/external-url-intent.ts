import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { externalUrlIntentGate } from '../external-url-intent';
import { requestExternalUrlIntent } from '../external-url-intent';
import { LINK_OPEN } from '@shared/link-open-intent';
import { openLink } from '../link-open-intent';
import { readLinkFile } from '../link-file-preview';
import { getProjectsRepository } from '../projects/repository-provider';

export function registerExternalUrlIntentHandlers(): void {
  ipcMain.handle(LINK_OPEN.submit, async (_event, payload: unknown) => {
    try {
      return await openLink(payload, {
        external: requestExternalUrlIntent,
        web: projectId => {
          if (!getProjectsRepository().get(projectId)) throw new Error('Source project is unavailable');
        },
        file: input => {
          if (input.source.kind === 'app-window') throw new Error('Source project is required');
          const project = getProjectsRepository().get(input.source.projectId);
          if (!project) throw new Error('Source project is unavailable');
          return readLinkFile(input, project);
        },
      });
    } catch (error) {
      const url = payload && typeof payload === 'object' && 'url' in payload && typeof payload.url === 'string'
        ? payload.url : '';
      return { kind: 'message', title: error instanceof Error ? error.message : 'Shelf could not open this link', url };
    }
  });
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
