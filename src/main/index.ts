import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import { spawnPty, writePty, resizePty, killPty, killAllPtys, setMuted } from './pty-manager';
import { saveProjects } from './project-store';
import { clearAudit } from './audit-log';
import { saveSettings } from './settings-store';
import { bootstrap } from './bootstrap';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { uploadFile, clearUploads } from './file-transfer';
import { initAutoUpdater, stopAutoUpdater, manualCheckForUpdate, startUpdateDownload, confirmAndInstallUpdate } from './updater';
import { removeHostKey } from './ssh-control';
import { createConnector, getAvailableTypes, listDockerContainers, listWSLDistros, cleanupConnectors, setDockerPath, testDockerPath } from './connector';
import { loadSSHServers, saveSSHServer } from './ssh-server-store';
import { log, setLogLevel, setFileWriter } from '@shared/logger';
import { applyUserDataIsolation } from './user-data-path';
import type { Connection, ProjectConfig, AppSettings, FileUploadResult, FileClearResult, PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload } from '@shared/types';

applyUserDataIsolation();

let mainWindow: BrowserWindow | null = null;
let cachedProjects: ProjectConfig[] = [];
let cachedSettings: AppSettings = { ...DEFAULT_SETTINGS };

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

ipcMain.handle(IPC.PTY_SPAWN, (_event, payload: PtySpawnPayload) => {
  if (mainWindow) {
    spawnPty(payload.projectId, payload.tabId, payload.cwd, payload.connection, mainWindow, payload.initScript, payload.tabCmd);
  }
});

ipcMain.handle(IPC.PTY_KILL, (_event, payload: PtyKillPayload) => {
  killPty(payload.tabId);
});

ipcMain.handle(IPC.PROJECT_LOAD, () => {
  return cachedProjects;
});

ipcMain.handle(IPC.PROJECT_SAVE, (_event, projects: ProjectConfig[]) => {
  cachedProjects = projects;
  saveProjects(projects);
});

// ── Connector (unified) ──

ipcMain.handle(IPC.CONNECTOR_LIST_DIR, (_event, payload: { connection: Connection; path: string }) => {
  const connector = createConnector(payload.connection);
  return connector.listDir(payload.path);
});

ipcMain.handle(IPC.CONNECTOR_HOME_PATH, (_event, connection: Connection) => {
  const connector = createConnector(connection);
  return connector.homePath();
});

ipcMain.handle(IPC.CONNECTOR_CHECK, (_event, connection: Connection) => {
  const connector = createConnector(connection);
  return connector.isConnected();
});

ipcMain.handle(IPC.CONNECTOR_ESTABLISH, async (_event, payload: { connection: Connection; password?: string }) => {
  const connector = createConnector(payload.connection);
  await connector.connect(payload.password);
  // Auto-save SSH server on successful connect
  if (payload.connection.type === 'ssh') {
    saveSSHServer({
      host: payload.connection.host,
      port: payload.connection.port,
      user: payload.connection.user,
    });
  }
});

ipcMain.handle(IPC.CONNECTOR_AVAILABLE_TYPES, () => {
  return getAvailableTypes();
});

// ── Connector — type-specific ──

ipcMain.handle(IPC.SSH_REMOVE_HOST_KEY, (_event, payload: { host: string; port: number }) => {
  removeHostKey(payload.host, payload.port);
});

ipcMain.handle(IPC.SSH_SERVERS, () => {
  return loadSSHServers();
});

ipcMain.handle(IPC.WSL_LIST_DISTROS, () => {
  return listWSLDistros();
});

ipcMain.handle(IPC.DOCKER_LIST_CONTAINERS, () => {
  return listDockerContainers();
});

ipcMain.handle(IPC.DOCKER_TEST_PATH, (_event, dockerPathValue: string) => {
  return testDockerPath(dockerPathValue);
});

// ── File transfer ──

ipcMain.handle(
  IPC.FILE_UPLOAD,
  async (_event, payload: { connection: Connection; cwd: string; filename: string; buffer: ArrayBuffer }): Promise<FileUploadResult> => {
    try {
      const remotePath = await uploadFile(
        payload.connection,
        payload.cwd,
        payload.filename,
        Buffer.from(payload.buffer),
      );
      return { ok: true, remotePath };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.error('file-transfer', `upload failed: ${message}`);
      return { ok: false, reason: message };
    }
  },
);

ipcMain.handle(
  IPC.FILE_CLEAR_UPLOADS,
  async (_event, payload: { connection: Connection; cwd: string }): Promise<FileClearResult> => {
    try {
      const removed = await clearUploads(payload.connection, payload.cwd);
      return { ok: true, removed };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.error('file-transfer', `clearUploads failed: ${message}`);
      return { ok: false, reason: message };
    }
  },
);

// ── Dialogs ──

ipcMain.handle(IPC.DIALOG_WARN, async (_event, payload: { title: string; message: string }) => {
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

// ── Settings ──

ipcMain.handle(IPC.SETTINGS_LOAD, () => {
  return cachedSettings;
});

ipcMain.handle(IPC.SETTINGS_SAVE, (_event, settings: AppSettings) => {
  cachedSettings = settings;
  saveSettings(settings);
  setLogLevel(settings.logLevel);
  setDockerPath(settings.dockerPath);
});

// ── Logs ──

ipcMain.handle(IPC.APP_LOGS_PATH, () => {
  return path.join(app.getPath('userData'), 'logs');
});

ipcMain.handle(IPC.LOGS_CLEAR, () => {
  const logBaseDir = path.join(app.getPath('userData'), 'logs');
  if (fs.existsSync(logBaseDir)) {
    fs.rmSync(logBaseDir, { recursive: true, force: true });
  }
  clearAudit();
  log.info('app', 'logs cleared');
});

// ── Updater ──

ipcMain.handle(IPC.UPDATE_CHECK, () => {
  manualCheckForUpdate();
});

ipcMain.handle(IPC.UPDATE_DOWNLOAD, () => {
  startUpdateDownload();
});

ipcMain.handle(IPC.UPDATE_INSTALL, () => {
  return confirmAndInstallUpdate();
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
  const logBaseDir = path.join(app.getPath('userData'), 'logs');
  setFileWriter((line) => {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(logBaseDir, yyyymm);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${mmdd}.log`), line + '\n');
  });

  const envLogLevel = process.env.LOG_LEVEL as import('../shared/types').LogLevel | undefined;
  if (envLogLevel) setLogLevel(envLogLevel);

  const { projects, settings } = bootstrap();
  cachedProjects = projects;
  cachedSettings = settings;

  if (!envLogLevel) setLogLevel(settings.logLevel);
  setDockerPath(settings.dockerPath);

  log.info('app', `starting, logLevel=${settings.logLevel}, userData=${app.getPath('userData')}`);

  createWindow();
  if (process.env.NODE_ENV !== 'test' && app.isPackaged) {
    initAutoUpdater(mainWindow!);
  }
});

function shutdown() {
  killAllPtys();
  stopAutoUpdater();
  cleanupConnectors();
}

app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});

app.on('before-quit', () => {
  shutdown();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
