import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import {
  handlePmSend,
  getHistory,
  clearHistory,
  compactHistory,
  stopGeneration,
  updateSyncedState,
  isAwayMode,
  setAwayMode,
  updateKnownTabs,
  isPmActive,
  setPmActiveState,
  startTelegram,
  stopTelegram,
  setListenerStoppedCallback,
  type ListenerStopReason,
} from '../pm';
import { saveSettings } from '../settings-store';
import { getMainWindow, getSettings, setSettings } from '../app-state';

function persistPmActive(on: boolean): void {
  const next = { ...getSettings(), pmActive: on };
  setSettings(next);
  saveSettings(next);
}

/**
 * PM Active orchestration (Phase A). Turning on starts the telegram listener
 * (requires config); turning off stops it AND cascades Away off (can't be in
 * Away/autopilot with the bridge down). Persists the intent + mirrors state to
 * the renderer. Exported so the boot wiring can restore the persisted state.
 */
export function applyPmActive(on: boolean): void {
  const settings = getSettings();
  const hasConfig = !!(settings.telegram?.botToken && settings.telegram?.chatId);
  if (on && !hasConfig) {
    // No telegram config — can't go active. Keep off.
    setPmActiveState(false);
    persistPmActive(false);
    return;
  }
  setPmActiveState(on);
  persistPmActive(on);
  if (on) {
    startTelegram(settings.telegram!);
  } else {
    stopTelegram();
    setAwayMode(false); // cascade: no autopilot without the bridge
  }
}

// Listener stopped itself on a fatal/conflict error → reflect PM Active off +
// tell the renderer why (bad token / bad chat id / taken over by another host).
function handleListenerStopped(reason: ListenerStopReason): void {
  setPmActiveState(false);
  persistPmActive(false);
  setAwayMode(false);
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.PM_ACTIVE_ERROR, reason);
  }
}

export function registerPmHandlers(): void {
  setListenerStoppedCallback(handleListenerStopped);

  ipcMain.handle(IPC.PM_SEND, async (_event, message: string) => {
    const mainWindow = getMainWindow();
    const settings = getSettings();
    if (!mainWindow || !settings.pmProvider) return;
    await handlePmSend(message, settings.pmProvider, mainWindow);
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

  ipcMain.handle(IPC.PM_COMPACT, () => {
    return compactHistory();
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

  ipcMain.handle(IPC.PM_SET_ACTIVE, (_event, on: boolean) => {
    applyPmActive(on);
  });

  ipcMain.handle(IPC.PM_ACTIVE_GET, () => {
    return isPmActive();
  });
}
