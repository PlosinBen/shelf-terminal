import { useEffect } from 'react';
import type { ConfigBackupBinding } from '@shared/config-backup';
import {
  beginBackupConfigEdit,
  cancelBackupConfigEdit,
  getBackupPanelSnapshot,
  isBackupConfigDirty,
  setBackupActiveTab,
  startBackupPanelRequest,
  updateBackupConfigDraft,
  useBackupPanelStore,
} from '../backup-panel-store';
import { emitBackup } from '../events';
import { toggleRightSidebar } from '../store';

export function requestBackupPanelLoad(): void {
  emitBackup('backup:load-local', startBackupPanelRequest('load'));
}

export function requestBackupSettingsSave(settings: ConfigBackupBinding): void {
  emitBackup('backup:save-settings', {
    ...startBackupPanelRequest('save-settings'),
    settings,
  });
}

export function BackupView() {
  const panel = useBackupPanelStore();

  useEffect(() => {
    requestBackupPanelLoad();
  }, [panel.sessionRevision]);

  return (
    <aside className="right-panel backup-view" aria-label="Backup">
      <div className="right-panel-header">
        <span className="right-panel-title">Backup</span>
        <button
          className="notes-close"
          onClick={() => toggleRightSidebar('backup')}
          aria-label="Close Backup"
        >
          ×
        </button>
      </div>

      <div className="backup-panel-tabs" role="tablist" aria-label="Backup operations">
        <button
          className={`backup-panel-tab${panel.activeTab === 'backup' ? ' active' : ''}`}
          role="tab"
          aria-selected={panel.activeTab === 'backup'}
          onClick={() => setBackupActiveTab('backup')}
        >
          Back up
        </button>
        <button
          className={`backup-panel-tab${panel.activeTab === 'import' ? ' active' : ''}`}
          role="tab"
          aria-selected={panel.activeTab === 'import'}
          onClick={() => setBackupActiveTab('import')}
        >
          Import
        </button>
      </div>

      <div className="backup-panel-body" role="tabpanel">
        {panel.activeTab === 'backup' ? (
          <BackupConfig panel={panel} />
        ) : (
          <p className="web-settings-hint">Import Skills and MCP servers from a backup.</p>
        )}
      </div>
    </aside>
  );
}

function BackupConfig({ panel }: { panel: ReturnType<typeof getBackupPanelSnapshot> }) {
  if (!panel.loaded && panel.busy === 'load') {
    return <p className="web-settings-hint">Loading…</p>;
  }

  const configured = Boolean(panel.binding?.remoteUrl);
  const showForm = !configured || panel.configEditing;

  if (!showForm) {
    return (
      <section className="backup-config-summary">
        <div className="backup-section-heading">
          <div>
            <h3>Back up this machine</h3>
            <p className="web-settings-hint">Uses this machine's Git credentials.</p>
          </div>
          <button className="web-list-action" onClick={beginBackupConfigEdit}>Edit</button>
        </div>
        <dl className="backup-config-details">
          <dt>Remote</dt>
          <dd>{panel.binding!.remoteUrl}</dd>
          <dt>Machine</dt>
          <dd>{panel.binding!.machineLabel || 'Unnamed'}</dd>
        </dl>
        {panel.error && <p className="backup-status backup-status-err">{panel.error}</p>}
      </section>
    );
  }

  const dirty = isBackupConfigDirty(panel);
  const saving = panel.busy === 'save-settings';

  return (
    <section className="backup-config-form">
      <h3>Back up this machine</h3>
      <p className="web-settings-hint">
        Save a Git remote for Back up. Import can use a different URL.
      </p>
      <label className="backup-field">
        <span className="backup-field-label">Remote URL</span>
        <input
          className="backup-input"
          type="text"
          placeholder="git@github.com:me/shelf-backups.git"
          value={panel.configDraft.remoteUrl}
          onChange={(event) => updateBackupConfigDraft({ remoteUrl: event.target.value })}
        />
      </label>
      <label className="backup-field">
        <span className="backup-field-label">This machine's label</span>
        <input
          className="backup-input"
          type="text"
          placeholder="work-mac"
          value={panel.configDraft.machineLabel}
          onChange={(event) => updateBackupConfigDraft({ machineLabel: event.target.value })}
        />
        <span className="backup-field-hint">Display name shown when importing.</span>
      </label>
      {panel.error && <p className="backup-status backup-status-err">{panel.error}</p>}
      <div className="backup-actions">
        {panel.configEditing && (
          <button className="conn-btn conn-btn-cancel" disabled={saving} onClick={cancelBackupConfigEdit}>
            Cancel
          </button>
        )}
        <button
          className="conn-btn conn-btn-next"
          disabled={saving || !dirty}
          onClick={() => requestBackupSettingsSave(getBackupPanelSnapshot().configDraft)}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </section>
  );
}
