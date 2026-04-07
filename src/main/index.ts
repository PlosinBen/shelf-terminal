import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { IPC } from '../shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, killAllPtys } from './pty-manager';
import { loadProjects, saveProjects } from './project-store';
import { listDirectory, getHomePath } from './folder-list';
import { saveClipboardImage, startCleanupTimer, stopCleanupTimer, cleanupAllImages } from './clipboard-image';
import type { ProjectConfig, PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload, FolderListPayload } from '../shared/types';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
    spawnPty(payload.tabId, payload.cwd, mainWindow);
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
});

app.on('window-all-closed', () => {
  killAllPtys();
  stopCleanupTimer();
  cleanupAllImages();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
