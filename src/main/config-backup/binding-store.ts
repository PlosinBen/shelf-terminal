import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import { getAppInstanceId } from '../app-instance-id';
import { CONFIG_BACKUP_FILE, backupBranchRef, type ConfigBackupBinding } from '@shared/config-backup';

/**
 * Machine-local store for the config-backup binding (remote URL + this machine's
 * display label). Source of truth = `<userData>/config-backup.json`.
 *
 * This file is deliberately SEPARATE from settings.json and is NEVER part of any
 * backup payload — it describes *where this machine backs up to*, which is
 * machine-specific (like credentials / projects.json). Backing it up would be
 * circular and would leak the remote URL into every branch.
 */

function bindingPath(): string {
  return path.join(app.getPath('userData'), CONFIG_BACKUP_FILE);
}

/** Read the binding, or null if this machine has not been bound to a remote yet.
 *  A corrupt file is logged loud and treated as unbound (fail-loud, don't crash). */
export function loadBinding(): ConfigBackupBinding | null {
  let raw: string;
  try {
    raw = fs.readFileSync(bindingPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('config-backup', `failed to read ${bindingPath()}`, err);
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('config-backup', 'config-backup.json is not valid JSON — treating as unbound', err);
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as any).remoteUrl !== 'string' ||
    typeof (parsed as any).machineLabel !== 'string'
  ) {
    log.error('config-backup', 'config-backup.json has an unexpected shape — treating as unbound');
    return null;
  }
  const { remoteUrl, machineLabel } = parsed as ConfigBackupBinding;
  return { remoteUrl, machineLabel };
}

/** Persist the binding. Trims inputs; both fields are required and non-empty. */
export function saveBinding(binding: ConfigBackupBinding): void {
  const remoteUrl = binding.remoteUrl.trim();
  const machineLabel = binding.machineLabel.trim();
  if (!remoteUrl) throw new Error('config-backup: remoteUrl is required');
  if (!machineLabel) throw new Error('config-backup: machineLabel is required');
  const out: ConfigBackupBinding = { remoteUrl, machineLabel };
  fs.mkdirSync(path.dirname(bindingPath()), { recursive: true });
  fs.writeFileSync(bindingPath(), JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

/** Remove the binding (unbind this machine from its remote). Missing = no-op. */
export function clearBinding(): void {
  try {
    fs.rmSync(bindingPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('config-backup', `failed to remove ${bindingPath()}`, err);
    }
  }
}

/**
 * This machine's backup branch ref — deterministic from the stable
 * `app-instance-id`, so it is identical across app restarts and never collides
 * with another machine's branch.
 */
export function thisMachineBranchRef(): string {
  return backupBranchRef(getAppInstanceId());
}
