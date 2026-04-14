import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import { log } from '@shared/logger';
import type { AppSettings } from '@shared/types';
import type { LoadResult } from './project-store';

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): LoadResult<AppSettings> {
  const filePath = getSettingsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      log.info('settings-store', `no settings.json at ${filePath}, using defaults`);
      return { ok: true, value: { ...DEFAULT_SETTINGS } };
    }
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      log.error('settings-store', `permission denied reading ${filePath}: ${err?.message ?? err}`);
      return { ok: false, error: 'permission', path: filePath, message: err?.message ?? String(err) };
    }
    log.error('settings-store', `failed to read ${filePath}: ${err?.message ?? err}`);
    return { ok: false, error: 'read', path: filePath, message: err?.message ?? String(err) };
  }
  try {
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return { ok: true, value: { ...DEFAULT_SETTINGS, ...saved } };
  } catch (err: any) {
    log.error('settings-store', `failed to parse ${filePath}: ${err?.message ?? err}`);
    return { ok: false, error: 'parse', path: filePath, message: err?.message ?? String(err) };
  }
}

export function saveSettings(settings: AppSettings): void {
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}
