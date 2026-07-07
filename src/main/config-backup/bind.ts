import type { ConfigBackupBinding } from '@shared/config-backup';
import { saveBinding } from './binding-store';
import { preflight } from './preflight';

/**
 * Bind this machine to a backup remote: fail-loud preflight (git present +
 * remote reachable/authenticates) BEFORE persisting, so we never store a
 * binding that can't actually push. Auth is the machine's own git credentials —
 * Shelf validates reachability but holds no secret.
 */

export type BindResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'no-git' | 'remote'; message: string };

export async function bindRemote(input: ConfigBackupBinding): Promise<BindResult> {
  const remoteUrl = input.remoteUrl.trim();
  const machineLabel = input.machineLabel.trim();
  if (!remoteUrl || !machineLabel) {
    return { ok: false, reason: 'invalid', message: 'Both a remote URL and a machine label are required.' };
  }
  const pf = await preflight(remoteUrl);
  if (!pf.ok) return { ok: false, reason: pf.reason, message: pf.message };
  saveBinding({ remoteUrl, machineLabel });
  return { ok: true };
}
