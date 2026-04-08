import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { IPC } from '../shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, killAllPtys } from './pty-manager';
import { loadProjects, saveProjects } from './project-store';
import { loadSettings, saveSettings } from './settings-store';
import { listDirectory, getHomePath } from './folder-list';
import { saveClipboardImage, saveClipboardImageRemote, startCleanupTimer, stopCleanupTimer, cleanupAllImages } from './clipboard-image';
import { initAutoUpdater, stopAutoUpdater } from './updater';
import { cleanupControlSockets } from './ssh-control';
import { sshListDir } from './ssh-manager';
import { wslListDir, wslHomePath } from './wsl-manager';
import type { ProjectConfig, AppSettings, PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload, FolderListPayload, SSHListDirPayload, WSLListDirPayload } from '../shared/types';

// Isolate userData per environment to avoid config conflicts
if (process.env.NODE_ENV) {
  app.setPath('userData', app.getPath('userData') + '-' + process.env.NODE_ENV);
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ──

// Renderer → Main (invoke, returns result)
ipcMain.handle(IPC.PTY_SPAWN, (_event, payload: PtySpawnPayload) => {
  if (mainWindow) {
    spawnPty(payload.tabId, payload.cwd, payload.connection, mainWindow, payload.initScript);
  }
});

ipcMain.handle(IPC.PTY_KILL, (_event, payload: PtyKillPayload) => {
  killPty(payload.tabId);
});

ipcMain.handle(IPC.FOLDER_LIST, (_event, payload: FolderListPayload) => {
  return listDirectory(payload.path);
});

ipcMain.handle(IPC.HOME_PATH, () => {
  return getHomePath();
});

ipcMain.handle(IPC.PROJECT_LOAD, () => {
  return loadProjects();
});

ipcMain.handle(IPC.PROJECT_SAVE, (_event, projects: ProjectConfig[]) => {
  saveProjects(projects);
});

ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, (_event, buffer: ArrayBuffer) => {
  return saveClipboardImage(Buffer.from(buffer));
});

ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE_REMOTE, (_event, payload: { buffer: ArrayBuffer; host: string; port: number; user: string }) => {
  return saveClipboardImageRemote(Buffer.from(payload.buffer), payload.host, payload.port, payload.user);
});

ipcMain.handle(IPC.SSH_LIST_DIR, (_event, payload: SSHListDirPayload) => {
  return sshListDir(payload.host, payload.port, payload.user, payload.path);
});

ipcMain.handle(IPC.WSL_LIST_DIR, (_event, payload: WSLListDirPayload) => {
  return wslListDir(payload.distro, payload.path);
});

ipcMain.handle(IPC.WSL_HOME_PATH, (_event, distro: string) => {
  return wslHomePath(distro);
});

ipcMain.handle(IPC.SETTINGS_LOAD, () => {
  return loadSettings();
});

ipcMain.handle(IPC.SETTINGS_SAVE, (_event, settings: AppSettings) => {
  saveSettings(settings);
});

// Renderer → Main (send, fire-and-forget)
ipcMain.on(IPC.PTY_INPUT, (_event, payload: PtyInputPayload) => {
  writePty(payload.tabId, payload.data);
});

ipcMain.on(IPC.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
  resizePty(payload.tabId, payload.cols, payload.rows);
});

// ── App lifecycle ──

app.whenReady().then(() => {
  createWindow();
  startCleanupTimer();
  if (process.env.NODE_ENV !== 'test' && app.isPackaged) {
    initAutoUpdater();
  }
});

app.on('window-all-closed', () => {
  killAllPtys();
  stopCleanupTimer();
  stopAutoUpdater();
  cleanupAllImages();
  cleanupControlSockets();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
