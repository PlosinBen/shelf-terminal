import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { IPC } from '../shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, killAllPtys, setMuted } from './pty-manager';
import { loadProjects, saveProjects } from './project-store';
import { loadSettings, saveSettings } from './settings-store';
import { listDirectory, getHomePath } from './folder-list';
import { saveClipboardImage, saveClipboardImageRemote, saveClipboardImageDocker, startCleanupTimer, stopCleanupTimer, cleanupAllImages } from './clipboard-image';
import { initAutoUpdater, stopAutoUpdater, manualCheckForUpdate, downloadAndInstall } from './updater';
import { sshListDir, sshGetHomePath } from './ssh-manager';
import { removeHostKey } from './ssh-control';
import * as connectionManager from './connection-manager';
import { wslListDir, wslHomePath, wslListDistros } from './wsl-manager';
import { dockerListDir, dockerHomePath, dockerListContainers } from './docker-manager';
import { log, setLogLevel, setFileWriter } from '../shared/logger';
import type { Connection, ProjectConfig, AppSettings, PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload, FolderListPayload, SSHListDirPayload, WSLListDirPayload } from '../shared/types';

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
    show: process.env.NODE_ENV !== 'test',
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
    spawnPty(payload.tabId, payload.cwd, payload.connection, mainWindow, payload.initScript, payload.tabCmd);
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

ipcMain.handle(IPC.CONNECTION_CHECK, (_event, connection: Connection) => {
  return connectionManager.isConnected(connection);
});

ipcMain.handle(IPC.CONNECTION_ESTABLISH, (_event, payload: { connection: Connection; password?: string }) => {
  return connectionManager.connect(payload.connection, payload.password);
});

ipcMain.handle(IPC.SSH_REMOVE_HOST_KEY, (_event, payload: { host: string; port: number }) => {
  removeHostKey(payload.host, payload.port);
});

ipcMain.handle(IPC.SSH_HOME_PATH, (_event, payload: { host: string; port: number; user: string }) => {
  return sshGetHomePath(payload.host, payload.port, payload.user);
});

ipcMain.handle(IPC.WSL_LIST_DIR, (_event, payload: WSLListDirPayload) => {
  return wslListDir(payload.distro, payload.path);
});

ipcMain.handle(IPC.WSL_LIST_DISTROS, () => {
  return wslListDistros();
});

ipcMain.handle(IPC.WSL_HOME_PATH, (_event, distro: string) => {
  return wslHomePath(distro);
});

ipcMain.handle(IPC.DOCKER_LIST_CONTAINERS, () => {
  return dockerListContainers();
});

ipcMain.handle(IPC.DOCKER_LIST_DIR, (_event, payload: { container: string; path: string }) => {
  return dockerListDir(payload.container, payload.path);
});

ipcMain.handle(IPC.DOCKER_HOME_PATH, (_event, container: string) => {
  return dockerHomePath(container);
});

ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE_DOCKER, (_event, payload: { buffer: ArrayBuffer; container: string }) => {
  return saveClipboardImageDocker(Buffer.from(payload.buffer), payload.container);
});

ipcMain.handle(IPC.SETTINGS_LOAD, () => {
  return loadSettings();
});

ipcMain.handle(IPC.LOGS_CLEAR, () => {
  const logBaseDir = path.join(app.getPath('userData'), 'logs');
  if (fs.existsSync(logBaseDir)) {
    fs.rmSync(logBaseDir, { recursive: true, force: true });
  }
  log.info('app', 'logs cleared');
});

ipcMain.handle(IPC.SETTINGS_SAVE, (_event, settings: AppSettings) => {
  saveSettings(settings);
  setLogLevel(settings.logLevel);
});

ipcMain.handle(IPC.UPDATE_CHECK, () => {
  manualCheckForUpdate();
});

ipcMain.handle(IPC.UPDATE_INSTALL, () => {
  downloadAndInstall();
});

// Renderer → Main (send, fire-and-forget)
ipcMain.on(IPC.PTY_INPUT, (_event, payload: PtyInputPayload) => {
  writePty(payload.tabId, payload.data);
});

ipcMain.on(IPC.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
  resizePty(payload.tabId, payload.cols, payload.rows);
});

ipcMain.on(IPC.PTY_MUTE, (_event, payload: { tabId: string; muted: boolean }) => {
  setMuted(payload.tabId, payload.muted);
});

// ── App lifecycle ──

app.whenReady().then(() => {
  const settings = loadSettings();
  const envLogLevel = process.env.LOG_LEVEL as import('../shared/types').LogLevel | undefined;
  setLogLevel(envLogLevel || settings.logLevel);

  // Write logs to date-based file: {userData}/logs/{yyyymm}/{mmdd}.log
  const logBaseDir = path.join(app.getPath('userData'), 'logs');
  setFileWriter((line) => {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(logBaseDir, yyyymm);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${mmdd}.log`), line + '\n');
  });

  log.info('app', `starting, logLevel=${settings.logLevel}, userData=${app.getPath('userData')}`);

  createWindow();
  startCleanupTimer();
  if (process.env.NODE_ENV !== 'test' && app.isPackaged) {
    initAutoUpdater(mainWindow!);
  }
});

function shutdown() {
  killAllPtys();
  stopCleanupTimer();
  stopAutoUpdater();
  cleanupAllImages();
  connectionManager.cleanup();
}

app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});

// Playwright `app.close()` may invoke `app.quit()` directly without going through
// `window-all-closed`. Hook `before-quit` so SSH ControlMaster sockets are always
// cleaned up — otherwise ControlPersist keeps masters alive past test teardown.
app.on('before-quit', () => {
  shutdown();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
