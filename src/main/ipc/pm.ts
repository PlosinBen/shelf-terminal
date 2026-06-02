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
} from '../pm';
import { getMainWindow, getSettings } from '../app-state';

export function registerPmHandlers(): void {
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
}
