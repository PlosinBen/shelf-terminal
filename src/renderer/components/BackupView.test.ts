import { beforeEach, describe, expect, it } from 'vitest';
import type { BackupListResult } from '@shared/config-backup';
import {
  acceptBackupPanelList,
  getBackupPanelSnapshot,
  openBackupPanelSession,
} from '../backup-panel-store';
import { __resetBusForTests, onBackup } from '../events';
import { requestBackupPanelLoad, requestBackupSettingsSave } from './BackupView';

const EMPTY_LIST: BackupListResult = {
  binding: null,
  items: [],
  intent: [],
  suggestedLabel: 'test-machine',
};

describe('BackupView intents', () => {
  beforeEach(() => {
    __resetBusForTests();
    openBackupPanelSession();
  });

  it('emits a versioned load intent for the central App handler', () => {
    let received: { sessionRevision: number; requestRevision: number } | null = null;
    const off = onBackup('backup:load-local', (payload) => { received = payload; });

    requestBackupPanelLoad();

    expect(received).toEqual({
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 1,
    });
    expect(getBackupPanelSnapshot().busy).toBe('load');
    off();
  });

  it('emits settings through the bus and supersedes an older load completion', () => {
    let savePayload: unknown;
    let loadToken: { sessionRevision: number; requestRevision: number } | null = null;
    const offLoad = onBackup('backup:load-local', (payload) => { loadToken = payload; });
    const offSave = onBackup('backup:save-settings', (payload) => { savePayload = payload; });

    requestBackupPanelLoad();
    requestBackupSettingsSave({ remoteUrl: '/tmp/backup.git', machineLabel: 'work' });

    expect(savePayload).toEqual({
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 2,
      settings: { remoteUrl: '/tmp/backup.git', machineLabel: 'work' },
    });
    expect(acceptBackupPanelList(loadToken!, EMPTY_LIST)).toBe(false);
    expect(getBackupPanelSnapshot().busy).toBe('save-settings');
    offLoad();
    offSave();
  });
});
