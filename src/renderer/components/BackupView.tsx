import { useEffect } from 'react';
import type { ConfigBackupBinding } from '@shared/config-backup';
import {
  beginBackupConfigEdit,
  cancelBackupConfigEdit,
  getBackupPanelSnapshot,
  isBackupConfigDirty,
  setBackupActiveTab,
  setBackupSelectionExpanded,
  startBackupPanelRequest,
  toggleBackupItemSelection,
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

export function requestBackupRun(selectedIds: string[]): void {
  emitBackup('backup:run', {
    ...startBackupPanelRequest('run'),
    selectedIds,
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
    const selected = new Set(panel.selectedIds);
    const intent = new Set(panel.intent);
    const running = panel.busy === 'run';
    return (
      <section className="backup-config-summary">
        <div className="backup-section-heading">
          <div>
            <h3>Back up this machine</h3>
            <p className="web-settings-hint">Uses this machine's Git credentials.</p>
          </div>
          <button className="web-list-action" disabled={running} onClick={beginBackupConfigEdit}>Edit</button>
        </div>
        <dl className="backup-config-details">
          <dt>Remote</dt>
          <dd>{panel.binding!.remoteUrl}</dd>
          <dt>Machine</dt>
          <dd>{panel.binding!.machineLabel || 'Unnamed'}</dd>
        </dl>
        <section className="backup-selection" aria-label="Backup selection">
          <div className="backup-selection-heading">
            <div>
              <h3>Items to back up</h3>
              <p className="web-settings-hint">Only selected items are copied. Others stay unchanged.</p>
            </div>
            {panel.selectionExpanded ? (
              panel.selectedIds.length > 0 && (
                <button
                  className="web-list-action"
                  disabled={running}
                  onClick={() => setBackupSelectionExpanded(false)}
                >
                  Done
                </button>
              )
            ) : (
              <button
                className="web-list-action"
                disabled={running}
                onClick={() => setBackupSelectionExpanded(true)}
              >
                Change selection
              </button>
            )}
          </div>

          <BackupSelectionSummary panel={panel} selected={selected} intent={intent} />

          {panel.selectionExpanded && (
            <div className="backup-selection-groups">
              <BackupSelectionGroup
                title="Skills"
                items={panel.items.filter((item) => item.kind === 'skill')}
                selected={selected}
                intent={intent}
                disabled={running}
              />
              <BackupSelectionGroup
                title="MCP servers"
                items={panel.items.filter((item) => item.kind === 'mcp')}
                selected={selected}
                intent={intent}
                disabled={running}
              />
            </div>
          )}
        </section>
        {panel.status && <p className="backup-status backup-status-ok">{panel.status}</p>}
        {panel.error && <p className="backup-status backup-status-err">{panel.error}</p>}
        <div className="backup-actions">
          <button
            className="conn-btn conn-btn-next"
            disabled={running || panel.selectedIds.length === 0}
            onClick={() => requestBackupRun(getBackupPanelSnapshot().selectedIds)}
          >
            {running ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
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

function BackupSelectionSummary({
  panel,
  selected,
  intent,
}: {
  panel: ReturnType<typeof getBackupPanelSnapshot>;
  selected: Set<string>;
  intent: Set<string>;
}) {
  const rows = [
    { kind: 'skill' as const, label: 'Skills' },
    { kind: 'mcp' as const, label: 'MCP servers' },
  ];
  return (
    <div className="backup-selection-summary">
      {rows.map(({ kind, label }) => {
        const items = panel.items.filter((item) => item.kind === kind && item.valid);
        const selectedCount = items.filter((item) => selected.has(item.id)).length;
        const newUnselectedCount = items.filter(
          (item) => !intent.has(item.id) && !selected.has(item.id),
        ).length;
        return (
          <div className="backup-selection-summary-row" key={kind}>
            <span>{label}</span>
            <span>
              {selectedCount} selected
              {newUnselectedCount > 0 ? ` · ${newUnselectedCount} new not selected` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BackupSelectionGroup({
  title,
  items,
  selected,
  intent,
  disabled,
}: {
  title: string;
  items: ReturnType<typeof getBackupPanelSnapshot>['items'];
  selected: Set<string>;
  intent: Set<string>;
  disabled: boolean;
}) {
  return (
    <section className="backup-selection-group">
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="web-settings-hint">None found.</p>
      ) : items.map((item) => (
        <label className={`backup-check${item.valid ? '' : ' invalid'}`} key={item.id}>
          <input
            type="checkbox"
            checked={item.valid && selected.has(item.id)}
            disabled={disabled || !item.valid}
            onChange={() => toggleBackupItemSelection(item.id)}
          />
          <span className="backup-check-text">
            <span className="web-list-main">
              {item.name}
              {item.valid && !intent.has(item.id) && <span className="backup-item-badge">New</span>}
              {!item.valid && <span className="backup-item-badge invalid">Invalid</span>}
            </span>
            <span className="web-list-sub">
              {item.valid ? (item.detail ?? item.kind) : item.invalidReason}
            </span>
          </span>
        </label>
      ))}
    </section>
  );
}
