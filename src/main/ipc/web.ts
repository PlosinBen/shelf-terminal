import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { WebSessionEntry, WebGrantsByProject } from '@shared/web-session';
import { listSessions, deleteSession } from '../web-session';
import { listAllGrants, revoke } from '../web-grants';
import { registerWebPermissionHandlers } from '../web-permission';

// IPC for the "manage web sessions & grants" UI (Settings → Web). Read-only
// listing plus destructive delete/revoke. The web.fetch op itself + its
// permission gate are wired separately (with the agent-server op).
export function registerWebHandlers(): void {
  ipcMain.handle(IPC.WEB_LIST_SESSIONS, (): Promise<WebSessionEntry[]> => listSessions());

  ipcMain.handle(IPC.WEB_DELETE_SESSION, (_e, domain: unknown): Promise<void> => {
    if (typeof domain !== 'string' || !domain) return Promise.resolve();
    return deleteSession(domain);
  });

  ipcMain.handle(IPC.WEB_LIST_GRANTS, (): WebGrantsByProject => listAllGrants());

  ipcMain.handle(IPC.WEB_REVOKE_GRANT, (_e, payload: unknown): void => {
    const { projectId, origin } = (payload ?? {}) as { projectId?: string; origin?: string };
    if (!projectId || !origin) return;
    revoke(projectId, origin);
  });

  registerWebPermissionHandlers();
}
