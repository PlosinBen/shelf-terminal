import fs from 'fs';
import { app, dialog } from 'electron';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { log } from '@shared/logger';
import { loadProjects } from './project-store';
import { loadSettings } from './settings-store';
import type { LoadResult } from './project-store';
import type { AppSettings, ProjectConfig } from '@shared/types';

export interface BootstrapResult {
  projects: ProjectConfig[];
  settings: AppSettings;
}

type DialogChoice = 'quit' | 'continue';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function timestampSuffix(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getMockResponse(): DialogChoice | null {
  const v = process.env.SHELF_BOOTSTRAP_DIALOG_RESPONSE;
  if (v === 'quit' || v === 'continue') return v;
  return null;
}

function showParseDialog(label: string, filePath: string, message: string): DialogChoice {
  const mock = getMockResponse();
  if (mock) {
    log.info('bootstrap', `mock dialog (parse) ${label} → ${mock}`);
    return mock;
  }
  const result = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Shelf Terminal — Config error',
    message: `Failed to parse ${label}`,
    detail: `File: ${filePath}\n\n${message}\n\nQuit to inspect the file, or back up the corrupt copy and continue with defaults.`,
    buttons: ['Quit', 'Backup & Continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result === 1 ? 'continue' : 'quit';
}

function showPermissionDialog(label: string, filePath: string, message: string): void {
  const mock = getMockResponse();
  if (mock) {
    log.info('bootstrap', `mock dialog (permission) ${label} → quit`);
    return;
  }
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Shelf Terminal — Permission denied',
    message: `Cannot read ${label}`,
    detail: `File: ${filePath}\n\n${message}\n\nFix the file permissions (e.g. \`chmod 600 "${filePath}"\`) and relaunch.`,
    buttons: ['Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

function showReadDialog(label: string, filePath: string, message: string): void {
  const mock = getMockResponse();
  if (mock) {
    log.info('bootstrap', `mock dialog (read) ${label} → quit`);
    return;
  }
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Shelf Terminal — Config read error',
    message: `Cannot read ${label}`,
    detail: `File: ${filePath}\n\n${message}`,
    buttons: ['Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

function showBackupFailedDialog(filePath: string, message: string): void {
  const mock = getMockResponse();
  if (mock) {
    log.info('bootstrap', `mock dialog (backup-failed) → quit`);
    return;
  }
  dialog.showMessageBoxSync({
    type: 'error',
    title: 'Shelf Terminal — Backup failed',
    message: 'Could not back up the corrupt config file',
    detail: `File: ${filePath}\n\n${message}\n\nResolve the file manually before relaunching.`,
    buttons: ['Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

/**
 * Rename `filePath` to `<filePath>.corrupt.<timestamp>`.
 * Returns null on success, error message on failure.
 */
function backupCorruptFile(filePath: string): string | null {
  const backupPath = `${filePath}.corrupt.${timestampSuffix()}`;
  try {
    fs.renameSync(filePath, backupPath);
    log.info('bootstrap', `renamed corrupt config: ${filePath} → ${backupPath}`);
    return null;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.error('bootstrap', `failed to back up ${filePath}: ${msg}`);
    return msg;
  }
}

function handleLoadError<T>(
  label: string,
  fallback: T,
  result: Extract<LoadResult<T>, { ok: false }>,
): T {
  if (result.error === 'parse') {
    const choice = showParseDialog(label, result.path, result.message);
    if (choice === 'quit') {
      app.exit(0);
      throw new Error('app exiting');
    }
    const backupErr = backupCorruptFile(result.path);
    if (backupErr) {
      showBackupFailedDialog(result.path, backupErr);
      app.exit(1);
      throw new Error('app exiting');
    }
    return fallback;
  }
  if (result.error === 'permission') {
    showPermissionDialog(label, result.path, result.message);
    app.exit(0);
    throw new Error('app exiting');
  }
  // 'read'
  showReadDialog(label, result.path, result.message);
  app.exit(0);
  throw new Error('app exiting');
}

export function bootstrap(): BootstrapResult {
  const projectsResult = loadProjects();
  const projects: ProjectConfig[] = projectsResult.ok
    ? projectsResult.value
    : handleLoadError('projects.json', [] as ProjectConfig[], projectsResult);

  const settingsResult = loadSettings();
  const settings: AppSettings = settingsResult.ok
    ? settingsResult.value
    : handleLoadError('settings.json', { ...DEFAULT_SETTINGS }, settingsResult);

  return { projects, settings };
}
