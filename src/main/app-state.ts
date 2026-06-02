import type { BrowserWindow } from 'electron';
import type { ProjectConfig, AppSettings } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/defaults';

/**
 * Authoritative in-memory app state shared between the window lifecycle code in
 * index.ts and the per-domain IPC handlers in src/main/ipc/. Handlers both read
 * and mutate these (PROJECT_SAVE writes projects, SETTINGS_SAVE writes settings,
 * PM_SEND reads settings), so they live in one module with accessors rather than
 * being threaded through every register function as parameters.
 */

let mainWindow: BrowserWindow | null = null;
let cachedProjects: ProjectConfig[] = [];
let cachedSettings: AppSettings = { ...DEFAULT_SETTINGS };

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getProjects(): ProjectConfig[] {
  return cachedProjects;
}

export function setProjects(projects: ProjectConfig[]): void {
  cachedProjects = projects;
}

export function getSettings(): AppSettings {
  return cachedSettings;
}

export function setSettings(settings: AppSettings): void {
  cachedSettings = settings;
}
