import { autoUpdater } from 'electron-updater';
import { dialog, BrowserWindow } from 'electron';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastCheckTime = 0;

function checkForUpdates() {
  lastCheckTime = Date.now();
  autoUpdater.checkForUpdates().catch(() => {});
}

export function initAutoUpdater(win: BrowserWindow) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', async (info) => {
    const focusedWin = BrowserWindow.getFocusedWindow();
    const result = await dialog.showMessageBox(focusedWin ?? ({} as any), {
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
    const focusedWin = BrowserWindow.getFocusedWindow();
    const result = await dialog.showMessageBox(focusedWin ?? ({} as any), {
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
    console.error('Auto-updater error:', err.message);
  });

  // Check on startup after short delay
  updateCheckTimer = setTimeout(checkForUpdates, 5000);

  // Check on window focus if enough time has passed
  win.on('focus', () => {
    if (Date.now() - lastCheckTime >= CHECK_INTERVAL_MS) {
      checkForUpdates();
    }
  });
}

export function stopAutoUpdater() {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
}
