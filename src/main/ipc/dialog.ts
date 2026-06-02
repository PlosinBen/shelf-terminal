import { dialog, ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { getMainWindow } from '../app-state';

export function registerDialogHandlers(): void {
  ipcMain.handle(IPC.DIALOG_WARN, async (_event, payload: { title: string; message: string }) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: payload.title,
      message: payload.message,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    });
  });

  ipcMain.handle(
    IPC.DIALOG_CONFIRM,
    async (_event, payload: { title: string; message: string; confirmLabel?: string }): Promise<boolean> => {
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: payload.title,
        message: payload.message,
        buttons: [payload.confirmLabel ?? 'OK', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      return result.response === 0;
    },
  );
}
