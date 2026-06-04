import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { writePty, killAllPtys, setPtyObserver } from './pty-manager';
import { bootstrap } from './bootstrap';
import { initAutoUpdater, stopAutoUpdater, manualCheckForUpdate } from './updater';
import { buildAppMenu } from './app-menu';
import { isReloadKeyEvent } from './reload-guard';
import { cleanupConnectors } from './connector';
import { log, setLogLevel, setFileWriter } from '@shared/logger';
import { applyUserDataIsolation } from './user-data-path';
import { migratePmNotes } from './migrations/migrate-pm-notes';
import { handlePmSend, handleTabEvent, stopGeneration, setWritePtyFn, initAwayMode, initPmActive, initTelegramBridge, setProjectsProvider, setStateChangeCallback, stopTelegram, setMessageCallback, setCallbackQueryHandler, setStopCallback, handlePtyData, handlePtyRemove, handlePtyClear } from './pm';
import { applyPmActive } from './ipc/pm';
import { initAgentManager, disposeAllAgents } from './agent';
import { getMainWindow, setMainWindow, setProjects, setSettings, getSettings, getProjects } from './app-state';
import { registerAllIpcHandlers } from './ipc';

applyUserDataIsolation();

function createWindow() {
  const win = new BrowserWindow({
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
  setMainWindow(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Defense-in-depth: if anything tries to navigate the renderer frame away
  // from Shelf (markdown link missing target=_blank, stray window.location,
  // form submission, etc.), block the navigation and offer to open the URL
  // in the system browser instead. We never want the renderer to actually
  // navigate — that wipes agent state, terminal scrollback, panel layout.
  win.webContents.on('will-navigate', (event, url) => {
    // Initial app load (file:// in prod, vite dev server URL in dev) is allowed
    // to pass through; only intercept post-load navigations.
    const current = win.webContents.getURL();
    if (current && url === current) return;

    event.preventDefault();

    const isOpenable = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:');
    dialog
      .showMessageBox(win, {
        type: 'question',
        title: 'Leave Shelf?',
        message: `A link is trying to navigate Shelf to:\n${url}`,
        detail: isOpenable
          ? 'Cancel keeps Shelf where it is. Open in browser sends the link to your default browser.'
          : 'This URL cannot be opened externally. Cancel to stay in Shelf.',
        buttons: isOpenable ? ['Cancel', 'Open in browser'] : ['Cancel'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then((result) => {
        if (isOpenable && result.response === 1) {
          shell.openExternal(url);
        }
      });
  });

  // Intercept Cmd/Ctrl+R, Shift+Cmd/Ctrl+R, and F5 — a stray reload would clear
  // xterm scrollback and force the renderer to reconnect. Confirm with the user
  // first regardless of which platform-specific key they hit.
  win.webContents.on('before-input-event', (event, input) => {
    if (!isReloadKeyEvent(input)) return;
    event.preventDefault();
    dialog
      .showMessageBox(win, {
        type: 'question',
        title: 'Reload Shelf?',
        message: 'Reloading the window clears terminal scrollback.',
        detail: 'Active pty processes keep running, but visible output history will be lost. Continue?',
        buttons: ['Cancel', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then((result) => {
        if (result.response === 1 && !win.isDestroyed()) {
          win.webContents.reload();
        }
      });
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../index.html'));
  }

  win.on('closed', () => {
    setMainWindow(null);
  });
}

registerAllIpcHandlers();

// ── App lifecycle ──

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildAppMenu({ onCheckForUpdates: manualCheckForUpdate }));

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
  setProjects(projects);
  setSettings(settings);

  if (!envLogLevel) setLogLevel(settings.logLevel);

  log.info('app', `starting, logLevel=${settings.logLevel}, userData=${app.getPath('userData')}`);

  await migratePmNotes();

  createWindow();

  // Agent View wiring
  initAgentManager(() => getMainWindow());

  // PM wiring
  initAwayMode(getMainWindow()!);
  initPmActive(getMainWindow()!);
  // Telegram bridge's permanent global agent-event observer. Registered once
  // here so it lives the process lifetime, regardless of PM Active on/off.
  // The handler's mode-gate decides whether to forward events to Telegram —
  // PM Active off → `mode = pm` → everything dropped on the floor.
  initTelegramBridge();
  setProjectsProvider(() => getProjects().map((p) => ({ name: p.name, connectionType: p.connection.type })));
  setWritePtyFn(writePty);
  // Feed PTY output/lifecycle into PM scrollback + tab-watcher (P1-1: the
  // dependency now points pm→infra via this injection, not pty-manager→pm).
  setPtyObserver({ onData: handlePtyData, onRemove: handlePtyRemove, onClear: handlePtyClear });
  setStateChangeCallback((tabId, tabName, projectName, oldState, newState) => {
    const win = getMainWindow();
    const pmProvider = getSettings().pmProvider;
    if (win && pmProvider) {
      handleTabEvent(tabId, tabName, projectName, oldState, newState, pmProvider, win);
    }
  });
  setMessageCallback(async (text, _chatId) => {
    const win = getMainWindow();
    const pmProvider = getSettings().pmProvider;
    if (win && pmProvider) {
      // If Away Mode is OFF and user sends a command (not just a question),
      // PM will respond read-only. The user can use /away to toggle.
      handlePmSend(`[from Telegram] ${text}`, pmProvider, win);
    }
  });
  setCallbackQueryHandler((action, tabId) => {
    const win = getMainWindow();
    const pmProvider = getSettings().pmProvider;
    if (win && pmProvider) {
      const verb = action === 'allow' ? 'approved' : 'denied';
      handlePmSend(`[from Telegram] User ${verb} the permission request for tab ${tabId}. Send the appropriate keystroke.`, pmProvider, win);
    }
  });
  setStopCallback(() => {
    stopGeneration();
  });
  // Restore persisted PM Active intent: start the listener if it was on AND
  // telegram is configured. A bad token / taken-over on first fetch will then
  // auto-stop via the listener-stopped path (handleListenerStopped).
  if (settings.pmActive && settings.telegram?.botToken && settings.telegram?.chatId) {
    applyPmActive(true);
  }

  if (process.env.NODE_ENV !== 'test' && app.isPackaged) {
    initAutoUpdater(getMainWindow()!);
  }
});

function shutdown() {
  killAllPtys();
  disposeAllAgents();
  stopAutoUpdater();
  stopTelegram();
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
  if (getMainWindow() === null) {
    createWindow();
  }
});
