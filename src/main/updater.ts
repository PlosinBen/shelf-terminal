import { autoUpdater } from 'electron-updater';
import { dialog, BrowserWindow } from 'electron';

export function initAutoUpdater() {
  // Don't auto-download — let user decide
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', async (info) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showMessageBox(win ?? ({} as any), {
      type: 'info',
      title: 'Update Available',
      message: `Shelf Terminal v${info.version} is available.`,
      detail: 'Would you like to download and install it now?',
      buttons: ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on('update-downloaded', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showMessageBox(win ?? ({} as any), {
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded. Restart now to apply?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (err) => {
    // Silently ignore update errors (no network, etc.)
    console.error('Auto-updater error:', err.message);
  });

  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}
