import { beforeEach, describe, expect, it } from 'vitest';
import type { BackupListResult } from '@shared/config-backup';
import {
  acceptBackupPanelList,
  acceptImportItems,
  acceptImportSources,
  getBackupPanelSnapshot,
  openBackupPanelSession,
  selectAllValidImportItems,
  toggleBackupItemSelection,
  toggleImportItemSelection,
  updateImportUrl,
} from '../backup-panel-store';
import { __resetBusForTests, onBackup } from '../events';
import {
  requestBackupPanelLoad,
  requestBackupRun,
  requestBackupSettingsSave,
  requestImportSourceDiscovery,
  requestImportSourceLoad,
} from './BackupView';

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

  it('preselects only valid saved intent and leaves new items unchecked', () => {
    requestBackupPanelLoad();
    const token = {
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 1,
    };
    acceptBackupPanelList(token, {
      binding: { remoteUrl: '/tmp/backup.git', machineLabel: 'work' },
      suggestedLabel: 'test-machine',
      intent: ['skill:alpha', 'skill:broken'],
      items: [
        { id: 'skill:alpha', kind: 'skill', name: 'alpha', valid: true },
        { id: 'skill:beta', kind: 'skill', name: 'beta', valid: true },
        {
          id: 'skill:broken',
          kind: 'skill',
          name: 'broken',
          valid: false,
          invalidReason: 'SKILL.md frontmatter is invalid',
        },
      ],
    });

    expect(getBackupPanelSnapshot().selectedIds).toEqual(['skill:alpha']);
    expect(getBackupPanelSnapshot().selectionExpanded).toBe(false);

    toggleBackupItemSelection('skill:beta');
    toggleBackupItemSelection('skill:broken');
    expect(getBackupPanelSnapshot().selectedIds).toEqual(['skill:alpha', 'skill:beta']);
  });

  it('emits the current selection through a versioned run intent', () => {
    let received: unknown;
    const off = onBackup('backup:run', (payload) => { received = payload; });

    requestBackupRun(['skill:alpha', 'mcp:fs']);

    expect(received).toEqual({
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 1,
      selectedIds: ['skill:alpha', 'mcp:fs'],
    });
    expect(getBackupPanelSnapshot().busy).toBe('run');
    off();
  });

  it('seeds the transient Import URL once and invalidates discovery when edited', () => {
    requestBackupPanelLoad();
    acceptBackupPanelList({
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 1,
    }, {
      ...EMPTY_LIST,
      binding: { remoteUrl: '/saved.git', machineLabel: 'work' },
    });
    expect(getBackupPanelSnapshot().importUrl).toBe('/saved.git');

    updateImportUrl('/transient.git');
    let discovery: unknown;
    const off = onBackup('backup:find-import-sources', (payload) => { discovery = payload; });
    requestImportSourceDiscovery();
    const token = discovery as { sessionRevision: number; requestRevision: number };

    updateImportUrl('/new.git');
    expect(acceptImportSources(token, [])).toBe(false);
    expect(getBackupPanelSnapshot().importUrl).toBe('/new.git');
    expect(getBackupPanelSnapshot().importSources).toBeNull();
    off();
  });

  it('emits the pinned source load and defaults every valid item unchecked', () => {
    updateImportUrl('/transient.git');
    let received: unknown;
    const off = onBackup('backup:load-import-source', (payload) => { received = payload; });

    requestImportSourceLoad('opaque-revision');
    expect(received).toEqual({
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 2,
      remoteUrl: '/transient.git',
      sourceRevision: 'opaque-revision',
    });

    const token = {
      sessionRevision: getBackupPanelSnapshot().sessionRevision,
      requestRevision: 2,
    };
    acceptImportItems(token, {
      issues: [{ scope: 'mcp', message: 'broken MCP file' }],
      items: [
        { id: 'skill:new', kind: 'skill', name: 'new', valid: true, impact: 'new' },
        {
          id: 'skill:broken',
          kind: 'skill',
          name: 'broken',
          valid: false,
          invalidReason: 'bad SKILL.md',
          impact: 'new',
        },
        { id: 'mcp:fs', kind: 'mcp', name: 'fs', valid: true, impact: 'replace-local' },
      ],
    });
    expect(getBackupPanelSnapshot().importSelectedIds).toEqual([]);

    toggleImportItemSelection('skill:broken');
    expect(getBackupPanelSnapshot().importSelectedIds).toEqual([]);
    selectAllValidImportItems();
    expect(getBackupPanelSnapshot().importSelectedIds).toEqual(['skill:new', 'mcp:fs']);
    expect(getBackupPanelSnapshot().importIssues).toEqual([
      { scope: 'mcp', message: 'broken MCP file' },
    ]);
    off();
  });
});
