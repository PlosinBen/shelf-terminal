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
import { handlePmSend, handleTabEvent, getHistory, clearHistory, stopGeneration, updateSyncedState, setWritePtyFn, isAwayMode, setAwayMode, initAwayMode, setStateChangeCallback, updateKnownTabs } from './pm';
import type { Connection, ProjectConfig, AppSettings, FileUploadResult, FileClearResult, PtySpawnPayload, PtyInputPayload, PtyResizePayload, PtyKillPayload, GitBranchInfo, WorktreeAddResult, WorktreeRemoveResult } from '@shared/types';

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

ipcMain.handle(IPC.PROJECT_VALIDATE_DIRS, (_event, projects: ProjectConfig[]): string[] => {
  const invalid: string[] = [];
  for (const p of projects) {
    if (p.connection.type === 'local' && !fs.existsSync(p.cwd)) {
      invalid.push(p.id);
    }
  }
  return invalid;
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

// ── Git ──

ipcMain.handle(IPC.GIT_BRANCH_LIST, async (_event, payload: { connection: Connection; cwd: string }): Promise<GitBranchInfo[]> => {
  try {
    const connector = createConnector(payload.connection);
    const [branchResult, worktreeResult] = await Promise.all([
      connector.exec(payload.cwd, 'git branch --no-color 2>/dev/null'),
      connector.exec(payload.cwd, 'git worktree list --porcelain 2>/dev/null').catch(() => ({ stdout: '', stderr: '' })),
    ]);

    // Parse worktree list to map branch → path
    const worktreeMap = new Map<string, string>();
    let currentPath = '';
    for (const line of worktreeResult.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/')) {
        worktreeMap.set(line.slice('branch refs/heads/'.length), currentPath);
      }
    }

    return branchResult.stdout.trim().split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const name = line.replace(/^[*+]?\s+/, '');
        const isCurrent = line.startsWith('*');
        const worktreePath = !isCurrent ? worktreeMap.get(name) : undefined;
        return { name, current: isCurrent, worktreePath };
      });
  } catch {
    return [];
  }
});

ipcMain.handle(IPC.GIT_CHECK_DIRTY, async (_event, payload: { connection: Connection; cwd: string }): Promise<boolean> => {
  try {
    const connector = createConnector(payload.connection);
    const { stdout } = await connector.exec(payload.cwd, 'git status --porcelain 2>/dev/null');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
});

ipcMain.handle(IPC.GIT_CHECKOUT, async (_event, payload: { connection: Connection; cwd: string; branch: string }): Promise<{ ok: boolean; error?: string }> => {
  try {
    const connector = createConnector(payload.connection);
    await connector.exec(payload.cwd, `git checkout ${JSON.stringify(payload.branch)}`);
    return { ok: true };
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).replace(/^Error:\s*/, '');
    return { ok: false, error: msg };
  }
});

ipcMain.handle(
  IPC.GIT_WORKTREE_ADD,
  async (_event, payload: { connection: Connection; cwd: string; branch: string; newBranch: boolean }): Promise<WorktreeAddResult> => {
    try {
      const connector = createConnector(payload.connection);
      const parentDir = payload.cwd.replace(/\/+$/, '').replace(/[^/]+$/, '').replace(/\/+$/, '');
      const dirName = `${payload.cwd.replace(/\/+$/, '').split('/').pop()}-${payload.branch.replace(/\//g, '-')}`;
      const worktreePath = `${parentDir}/${dirName}`;

      const branchFlag = payload.newBranch ? '-b' : '';
      const cmd = branchFlag
        ? `git worktree add ${branchFlag} ${JSON.stringify(payload.branch)} ${JSON.stringify(worktreePath)}`
        : `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(payload.branch)}`;

      await connector.exec(payload.cwd, cmd);
      return { ok: true, path: worktreePath };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
);

ipcMain.handle(
  IPC.GIT_WORKTREE_REMOVE,
  async (_event, payload: { connection: Connection; cwd: string; worktreePath: string }): Promise<WorktreeRemoveResult> => {
    try {
      const connector = createConnector(payload.connection);
      await connector.exec(payload.cwd, `git worktree remove ${JSON.stringify(payload.worktreePath)} --force`);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },
);

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

// ── PM Agent ──

ipcMain.handle(IPC.PM_SEND, async (_event, message: string) => {
  if (!mainWindow || !cachedSettings.pmProvider) return;
  await handlePmSend(message, cachedSettings.pmProvider, mainWindow);
});

ipcMain.handle(IPC.PM_STOP, () => {
  stopGeneration();
});

ipcMain.handle(IPC.PM_HISTORY, () => {
  return getHistory();
});

ipcMain.handle(IPC.PM_CLEAR, () => {
  clearHistory();
});

ipcMain.on(IPC.PM_SYNC_STATE, (_event, state: any) => {
  updateSyncedState(state);
  // Also update tab watcher's known tabs
  const tabs: { tabId: string; tabName: string; projectName: string }[] = [];
  for (const proj of state) {
    for (const tab of proj.tabs) {
      tabs.push({ tabId: tab.id, tabName: tab.label, projectName: proj.name });
    }
  }
  updateKnownTabs(tabs);
});

ipcMain.handle(IPC.PM_AWAY_MODE, (_event, on: boolean) => {
  setAwayMode(on);
});

ipcMain.handle(IPC.PM_AWAY_MODE_GET, () => {
  return isAwayMode();
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

  // PM wiring
  initAwayMode(mainWindow!);
  setWritePtyFn(writePty);
  setStateChangeCallback((tabId, tabName, projectName, oldState, newState) => {
    if (mainWindow && cachedSettings.pmProvider) {
      handleTabEvent(tabId, tabName, projectName, oldState, newState, cachedSettings.pmProvider, mainWindow);
    }
  });

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
