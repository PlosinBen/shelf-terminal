import type { ConfigBackupBinding } from '@shared/config-backup';
import { emit, on } from './bus';
import type { BackupPanelRequestToken } from '../backup-panel-store';

export interface BackupEventMap {
  'backup:load-local': BackupPanelRequestToken;
  'backup:save-settings': BackupPanelRequestToken & { settings: ConfigBackupBinding };
  'backup:run': BackupPanelRequestToken & { selectedIds: string[] };
  'backup:find-import-sources': BackupPanelRequestToken & { remoteUrl: string };
  'backup:load-import-source': BackupPanelRequestToken & {
    remoteUrl: string;
    sourceRevision: string;
  };
}

export type BackupEventName = keyof BackupEventMap;

export function onBackup<K extends BackupEventName>(
  event: K,
  handler: (payload: BackupEventMap[K]) => void,
): () => void {
  return on(event, handler as (...args: any[]) => void);
}

export function emitBackup<K extends BackupEventName>(event: K, payload: BackupEventMap[K]): void {
  emit(event, payload);
}
