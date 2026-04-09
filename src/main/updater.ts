import { autoUpdater } from 'electron-updater';
import { BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { log } from '../shared/logger';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastCheckTime = 0;
let win: BrowserWindow | null = null;
let availableVersion: string | null = null;

function sendStatus(status: { available: boolean; version?: string }) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.UPDATE_STATUS, status);
  }
}

function checkForUpdates() {
  lastCheckTime = Date.now();
  autoUpdater.checkForUpdates().catch(() => {});
}

export function initAutoUpdater(mainWindow: BrowserWindow) {
  win = mainWindow;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version;
    log.info('updater', `update available: v${info.version}`);
    sendStatus({ available: true, version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    availableVersion = null;
    sendStatus({ available: false });
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('updater', 'update downloaded, quitting and installing');
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    log.error('updater', `error: ${err.message}`);
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

export function manualCheckForUpdate() {
  checkForUpdates();
}

export function downloadAndInstall() {
  if (availableVersion) {
    autoUpdater.downloadUpdate();
  }
}

export function stopAutoUpdater() {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
}
