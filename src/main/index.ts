import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { IPC } from '../shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, killAllPtys } from './pty-manager';
import { loadProjects, saveProjects } from './project-store';
import { loadSettings, saveSettings } from './settings-store';
import { listDirectory, getHomePath } from './folder-list';
import { saveClipboardImage, saveClipboardImageRemote, startCleanupTimer, stopCleanupTimer, cleanupAllImages } from './clipboard-image';
import { initAutoUpdater, stopAutoUpdater } from './updater';
import { cleanupControlSockets, checkConnection } from './ssh-control';
import { sshListDir, sshGetHomePath, sshEstablishConnection } from './ssh-manager';
import { wslListDir, wslHomePath, wslListDistros } from './wsl-manager';
import { log, setLogLevel, setFileWriter } from '../shared/logger';
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

ipcMain.handle(IPC.SSH_CHECK_CONNECTION, (_event, payload: { host: string; port: number; user: string }) => {
  return checkConnection(payload.host, payload.port, payload.user);
});

ipcMain.handle(IPC.SSH_ESTABLISH, (_event, payload: { host: string; port: number; user: string; password: string }) => {
  return sshEstablishConnection(payload.host, payload.port, payload.user, payload.password);
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

// Renderer → Main (send, fire-and-forget)
ipcMain.on(IPC.PTY_INPUT, (_event, payload: PtyInputPayload) => {
  writePty(payload.tabId, payload.data);
});

ipcMain.on(IPC.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
  resizePty(payload.tabId, payload.cols, payload.rows);
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
