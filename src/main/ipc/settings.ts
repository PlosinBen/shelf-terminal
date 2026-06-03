import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { saveSettings } from '../settings-store';
import { setLogLevel } from '@shared/logger';
import { startTelegram, isPmActive } from '../pm';
import { applyPmActive } from './pm';
import { getSettings, setSettings } from '../app-state';
import type { AppSettings } from '@shared/types';

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS_LOAD, () => {
    return getSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, settings: AppSettings) => {
    setSettings(settings);
    saveSettings(settings);
    setLogLevel(settings.logLevel);
    // The telegram listener is driven by PM Active now (not config presence).
    // Only react to config changes while already active: restart with the new
    // config, or drop active if the config was removed.
    if (isPmActive()) {
      if (settings.telegram?.botToken && settings.telegram?.chatId) {
        startTelegram(settings.telegram);
      } else {
        applyPmActive(false);
      }
    }
  });
}
