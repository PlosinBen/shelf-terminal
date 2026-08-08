import { useEffect } from 'react';
import type { ConfigBackupBinding } from '@shared/config-backup';
import {
  beginBackupConfigEdit,
  cancelBackupConfigEdit,
  getBackupPanelSnapshot,
  isBackupConfigDirty,
  selectAllValidImportItems,
  setBackupActiveTab,
  setBackupSelectionExpanded,
  startImportSourceDiscovery,
  startImportSourceLoad,
  startImportApply,
  startBackupPanelRequest,
  toggleBackupItemSelection,
  toggleImportItemSelection,
  updateBackupConfigDraft,
  updateImportUrl,
  useBackupPanelStore,
} from '../backup-panel-store';
import { emitBackup } from '../events';
import { RightPanel, RIGHT_PANEL_WIDTH } from './RightPanel';
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

export function requestImportSourceDiscovery(): void {
  const snapshot = getBackupPanelSnapshot();
  emitBackup('backup:find-import-sources', {
    ...startImportSourceDiscovery(),
    remoteUrl: snapshot.importUrl,
  });
}

export function requestImportSourceLoad(sourceRevision: string): void {
  const snapshot = getBackupPanelSnapshot();
  const token = startImportSourceLoad(sourceRevision);
  if (!sourceRevision) return;
  emitBackup('backup:load-import-source', {
    ...token,
    remoteUrl: snapshot.importUrl,
    sourceRevision,
  });
}

export function requestImportApply(): void {
  const snapshot = getBackupPanelSnapshot();
  if (!snapshot.importSourceRevision || snapshot.importSelectedIds.length === 0) return;
  emitBackup('backup:apply-import', {
    ...startImportApply(),
    remoteUrl: snapshot.importUrl,
    sourceRevision: snapshot.importSourceRevision,
    selectedIds: snapshot.importSelectedIds,
  });
}

export function BackupView() {
  const panel = useBackupPanelStore();
  const canonicalOperationRunning = panel.busy === 'run' || panel.busy === 'apply-import';

  useEffect(() => {
    requestBackupPanelLoad();
  }, [panel.sessionRevision]);

  return (
    <RightPanel
      className="backup-view"
      aria-label="Backup"
      defaultWidth={RIGHT_PANEL_WIDTH.defaults.backup}
      header={(
        <>
          <span className="right-panel-title">Backup</span>
          <button
            className="notes-close"
            onClick={() => toggleRightSidebar('backup')}
            aria-label="Close Backup"
          >
            ×
          </button>
        </>
      )}
    >
      <div className="backup-panel-tabs" role="tablist" aria-label="Backup operations">
        <button
          className={`backup-panel-tab${panel.activeTab === 'backup' ? ' active' : ''}`}
          role="tab"
          aria-selected={panel.activeTab === 'backup'}
          disabled={canonicalOperationRunning}
          onClick={() => setBackupActiveTab('backup')}
        >
          Back up
        </button>
        <button
          className={`backup-panel-tab${panel.activeTab === 'import' ? ' active' : ''}`}
          role="tab"
          aria-selected={panel.activeTab === 'import'}
          disabled={canonicalOperationRunning}
          onClick={() => setBackupActiveTab('import')}
        >
          Import
        </button>
      </div>

      <div className="backup-panel-body" role="tabpanel">
        {panel.activeTab === 'backup' ? (
          <BackupConfig panel={panel} />
        ) : (
          <ImportPanel panel={panel} />
        )}
      </div>
    </RightPanel>
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

function ImportPanel({ panel }: { panel: ReturnType<typeof getBackupPanelSnapshot> }) {
  if (!panel.loaded) return <p className="web-settings-hint">Loading…</p>;

  const finding = panel.busy === 'find-import-sources';
  const loadingSource = panel.busy === 'load-import-source';
  const applying = panel.busy === 'apply-import';
  const validItems = panel.importItems?.filter((item) => item.valid) ?? [];
  const allValidSelected = validItems.length > 0
    && validItems.every((item) => panel.importSelectedIds.includes(item.id));

  return (
    <section className="import-panel">
      <div>
        <h3>Import into this machine</h3>
        <p className="web-settings-hint">
          Find a backup from any Git remote. This URL is not saved.
        </p>
      </div>
      <label className="backup-field">
        <span className="backup-field-label">Remote URL</span>
        <input
          className="backup-input"
          type="text"
          placeholder="git@github.com:me/shelf-backups.git"
          value={panel.importUrl}
          disabled={applying}
          onChange={(event) => updateImportUrl(event.target.value)}
        />
      </label>
      <div className="backup-actions">
        <button
          className="conn-btn conn-btn-next"
          disabled={finding || applying || !panel.importUrl.trim()}
          onClick={requestImportSourceDiscovery}
        >
          {finding ? 'Finding…' : 'Find backups'}
        </button>
      </div>

      {panel.importSources && panel.importSources.length === 0 && (
        <p className="web-settings-hint">No Shelf backups found at this remote.</p>
      )}

      {panel.importSources && panel.importSources.length > 0 && (
        <label className="backup-field import-source-field">
          <span className="backup-field-label">Backup source</span>
          <select
            className="backup-input import-source"
            value={panel.importSourceRevision ?? ''}
            disabled={applying}
            onChange={(event) => requestImportSourceLoad(event.target.value)}
          >
            <option value="">Choose a backup…</option>
            {panel.importSources.map((source) => (
              <option key={source.sourceRevision} value={source.sourceRevision}>
                {source.machineLabel}{source.isSelf ? ' (this machine)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {loadingSource && <p className="web-settings-hint">Loading source…</p>}

      {panel.importItems && !loadingSource && (
        <section className="import-item-selection" aria-label="Import selection">
          <div className="backup-selection-heading">
            <div>
              <h3>Items to import</h3>
              <p className="web-settings-hint">Selected items will replace the same local item.</p>
            </div>
            <button
              className="web-list-action"
              disabled={applying || validItems.length === 0 || allValidSelected}
              onClick={selectAllValidImportItems}
            >
              Select all
            </button>
          </div>
          <div className="backup-selection-groups">
            <ImportSelectionGroup
              title="Skills"
              items={panel.importItems.filter((item) => item.kind === 'skill')}
              selectedIds={panel.importSelectedIds}
              disabled={applying}
            />
            <ImportSelectionGroup
              title="MCP servers"
              items={panel.importItems.filter((item) => item.kind === 'mcp')}
              selectedIds={panel.importSelectedIds}
              disabled={applying}
              issue={panel.importIssues.find((candidate) => candidate.scope === 'mcp')?.message}
            />
          </div>
          <p className="import-selection-count">
            {panel.importSelectedIds.length} selected
          </p>
          <div className="backup-actions">
            <button
              className="conn-btn conn-btn-next"
              disabled={applying || panel.importSelectedIds.length === 0}
              onClick={requestImportApply}
            >
              {applying
                ? 'Importing…'
                : `Import ${panel.importSelectedIds.length} item${panel.importSelectedIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </section>
      )}

      {panel.importStatus && <p className="backup-status backup-status-ok">{panel.importStatus}</p>}
      {panel.importFailure && <ImportFailureDetails failure={panel.importFailure} />}
      {panel.importError && <p className="backup-status backup-status-err">{panel.importError}</p>}
    </section>
  );
}

function ImportSelectionGroup({
  title,
  items,
  selectedIds,
  disabled,
  issue,
}: {
  title: string;
  items: NonNullable<ReturnType<typeof getBackupPanelSnapshot>['importItems']>;
  selectedIds: string[];
  disabled: boolean;
  issue?: string;
}) {
  const selected = new Set(selectedIds);
  return (
    <section className="backup-selection-group">
      <h4>{title}</h4>
      {issue && <p className="import-category-issue"><span>Invalid</span>{issue}</p>}
      {items.length === 0 && !issue ? (
        <p className="web-settings-hint">None found.</p>
      ) : items.map((item) => (
        <label className={`backup-check${item.valid ? '' : ' invalid'}`} key={item.id}>
          <input
            type="checkbox"
            checked={item.valid && selected.has(item.id)}
            disabled={disabled || !item.valid}
            onChange={() => toggleImportItemSelection(item.id)}
          />
          <span className="backup-check-text">
            <span className="web-list-main">
              {item.name}
              {item.valid ? (
                <span className={`import-impact ${item.impact}`}>
                  {item.impact === 'new' ? 'New' : 'Replace local'}
                </span>
              ) : (
                <span className="backup-item-badge invalid">Invalid</span>
              )}
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

function ImportFailureDetails({
  failure,
}: {
  failure: NonNullable<ReturnType<typeof getBackupPanelSnapshot>['importFailure']>;
}) {
  const phase = failure.phase[0].toUpperCase() + failure.phase.slice(1);
  const rollback = failure.rollback === 'not-needed'
    ? 'Not needed'
    : failure.rollback === 'completed' ? 'Completed' : 'Failed';
  return (
    <div className="import-failure" role="alert">
      <strong>{phase} failed</strong>
      {failure.itemId && <span>Item: {failure.itemId}</span>}
      <span>{failure.message}</span>
      <span>Rollback: {rollback}</span>
    </div>
  );
}
