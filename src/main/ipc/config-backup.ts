import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { BackupListResult, ConfigBackupBinding } from '@shared/config-backup';
import type { ImportDecision } from '@shared/config-backup';
import { loadBinding, clearBinding } from '../config-backup/binding-store';
import { loadIntent, clearIntent } from '../config-backup/intent-store';
import { bindRemote } from '../config-backup/bind';
import { enumerateLiveItems } from '../config-backup/enumerate';
import { runBackup } from '../config-backup/backup';
import { listBackupSources, listImportItems, planImport, applyImport } from '../config-backup/import';

/**
 * IPC surface for App-Level Config Backup & Copy (Backup half — Phase 2).
 * The Backup UI is a trigger; all git/transport work lives in ../config-backup.
 */
export function registerConfigBackupHandlers(): void {
  ipcMain.handle(IPC.CONFIG_BACKUP_GET_BINDING, async () => {
    return loadBinding();
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_BIND, async (_event, payload: ConfigBackupBinding) => {
    return bindRemote(payload);
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_UNBIND, async () => {
    clearBinding();
    clearIntent();
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_LIST, async (): Promise<BackupListResult> => {
    // Pre-tick comes from machine-local intent — no git, no network — so the
    // checklist opens instantly and works offline. The remote is only touched
    // when the user actually presses Back up (runBackup).
    const binding = loadBinding();
    const items = await enumerateLiveItems();
    return { binding, items, intent: binding ? loadIntent() : [] };
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_RUN, async (_event, selectedIds: string[]) => {
    return runBackup(selectedIds);
  });

  // ── Import (copy from a chosen branch into live) ──
  ipcMain.handle(IPC.CONFIG_BACKUP_LIST_SOURCES, async () => {
    return listBackupSources();
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_LIST_IMPORT_ITEMS, async (_event, ref: string) => {
    return listImportItems(ref);
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_PLAN_IMPORT, async (_event, payload: { ref: string; ids: string[] }) => {
    return planImport(payload.ref, payload.ids);
  });

  ipcMain.handle(IPC.CONFIG_BACKUP_APPLY_IMPORT, async (_event, payload: { ref: string; decisions: ImportDecision[] }) => {
    return applyImport(payload.ref, payload.decisions);
  });
}
