import type { BrowserWindow } from 'electron';
import type { AppSettings } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/defaults';

/**
 * Authoritative in-memory app state shared between the window lifecycle code in
 * index.ts and the per-domain IPC handlers in src/main/ipc/. Window and settings
 * remain here; canonical projects live behind the Main projects repository.
 */

let mainWindow: BrowserWindow | null = null;
let cachedSettings: AppSettings = { ...DEFAULT_SETTINGS };

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getSettings(): AppSettings {
  return cachedSettings;
}

export function setSettings(settings: AppSettings): void {
  cachedSettings = settings;
}
