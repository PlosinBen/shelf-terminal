import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import { CONFIG_BACKUP_INTENT_FILE } from '@shared/config-backup';

/**
 * Machine-local store for the backup INTENT — the set of item ids this machine
 * chose to back up. Source of truth = `<userData>/config-backup-intent.json`.
 *
 * The intent is a machine-local preference, deliberately decoupled from the
 * remote branch: which items I want backed up is MY choice, not something to
 * re-derive from the remote (that forced a network fetch just to open the
 * checklist). It seeds the checklist pre-tick; it is written when a Backup
 * succeeds (the committed set). Like the binding, it is NEVER part of any
 * backup payload.
 */

function intentPath(): string {
  return path.join(app.getPath('userData'), CONFIG_BACKUP_INTENT_FILE);
}

/** The last-chosen backup item ids, or [] if never backed up / unreadable.
 *  A corrupt file is logged loud and treated as empty (fail-loud, don't crash). */
export function loadIntent(): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(intentPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('config-backup', `failed to read ${intentPath()}`, err);
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
    log.error('config-backup', 'config-backup-intent.json has an unexpected shape — treating as empty');
    return [];
  } catch (err) {
    log.error('config-backup', 'config-backup-intent.json is not valid JSON — treating as empty', err);
    return [];
  }
}

/** Persist the chosen backup item ids (sorted for a stable file). */
export function saveIntent(ids: string[]): void {
  const out = [...new Set(ids)].sort();
  fs.mkdirSync(path.dirname(intentPath()), { recursive: true });
  fs.writeFileSync(intentPath(), JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

/** Remove the intent (on unbind). Missing = no-op. */
export function clearIntent(): void {
  try {
    fs.rmSync(intentPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('config-backup', `failed to remove ${intentPath()}`, err);
    }
  }
}
