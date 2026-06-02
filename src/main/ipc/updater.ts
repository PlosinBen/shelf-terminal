import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { manualCheckForUpdate, startUpdateDownload, confirmAndInstallUpdate } from '../updater';

export function registerUpdaterHandlers(): void {
  ipcMain.handle(IPC.UPDATE_CHECK, () => {
    manualCheckForUpdate();
  });

  ipcMain.handle(IPC.UPDATE_DOWNLOAD, () => {
    startUpdateDownload();
  });

  ipcMain.handle(IPC.UPDATE_INSTALL, () => {
    return confirmAndInstallUpdate();
  });
}
