import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { saveSettings } from '../settings-store';
import { setLogLevel } from '@shared/logger';
import { startTelegram, stopTelegram } from '../pm';
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
    // Restart Telegram if config changed
    if (settings.telegram?.botToken && settings.telegram?.chatId) {
      startTelegram(settings.telegram);
    } else {
      stopTelegram();
    }
  });
}
