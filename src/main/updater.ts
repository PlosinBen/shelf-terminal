import { autoUpdater, type ProgressInfo } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';
import type { UpdateStatus } from '@shared/types';
import { reduceUpdaterStatus, type UpdaterEvent } from './updater-state';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastCheckTime = 0;
let win: BrowserWindow | null = null;
let currentStatus: UpdateStatus = { state: 'idle' };
// When set, the next updater event triggers a user-facing dialog (so manual
// "Check for Updates" clicks get feedback even if there's no new version).
let manualCheckPending = false;

function dispatch(event: UpdaterEvent) {
  const next = reduceUpdaterStatus(currentStatus, event);
  if (next === currentStatus) return;
  currentStatus = next;
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.UPDATE_STATUS, next);
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
    log.info('updater', `update available: v${info.version}`);
    dispatch({ type: 'available', version: info.version });
    // No manual-check dialog here — the sidebar update button appearing is
    // already enough feedback, and a dialog would force a 2-step download.
    manualCheckPending = false;
  });

  autoUpdater.on('update-not-available', () => {
    dispatch({ type: 'not-available' });
    if (manualCheckPending && win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'No updates',
        message: `You're on the latest version (v${app.getVersion()}).`,
      });
    }
    manualCheckPending = false;
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    dispatch({
      type: 'download-progress',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('updater', `update downloaded: v${info.version}`);
    dispatch({ type: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    log.error('updater', `error: ${err.message}`);
    dispatch({ type: 'error' });
    if (manualCheckPending && win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: err.message,
      });
    }
    manualCheckPending = false;
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
  manualCheckPending = true;
  checkForUpdates();
}

/**
 * Begin downloading the available update. No-op if not in `available` state.
 */
export function startUpdateDownload() {
  if (currentStatus.state !== 'available') return;
  log.info('updater', `starting download v${currentStatus.version}`);
  dispatch({ type: 'start-download' });
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('updater', `downloadUpdate failed: ${err?.message ?? err}`);
    dispatch({ type: 'error' });
  });
}

/**
 * Show a confirmation dialog and, on user approval, quit and install.
 * No-op if no update has been downloaded yet.
 */
export async function confirmAndInstallUpdate() {
  if (currentStatus.state !== 'downloaded') return;
  if (!win || win.isDestroyed()) return;

  const version = currentStatus.version;
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Install update',
    message: `Install Shelf Terminal v${version}?`,
    detail: 'The app will quit and relaunch with the new version. Make sure you have saved your work.',
    buttons: ['Cancel', 'Install and Restart'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });

  if (result.response === 1) {
    log.info('updater', `user confirmed install v${version}, quitting and installing`);
    autoUpdater.quitAndInstall();
  }
}

export function stopAutoUpdater() {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
}
