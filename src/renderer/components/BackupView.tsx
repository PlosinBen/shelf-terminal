import { setBackupActiveTab, toggleRightSidebar, useStore } from '../store';

export function BackupView() {
  const { backupActiveTab } = useStore();

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
          className={`backup-panel-tab${backupActiveTab === 'backup' ? ' active' : ''}`}
          role="tab"
          aria-selected={backupActiveTab === 'backup'}
          onClick={() => setBackupActiveTab('backup')}
        >
          Back up
        </button>
        <button
          className={`backup-panel-tab${backupActiveTab === 'import' ? ' active' : ''}`}
          role="tab"
          aria-selected={backupActiveTab === 'import'}
          onClick={() => setBackupActiveTab('import')}
        >
          Import
        </button>
      </div>

      <div className="backup-panel-body" role="tabpanel">
        {backupActiveTab === 'backup' ? (
          <p className="web-settings-hint">Back up selected Skills and MCP servers.</p>
        ) : (
          <p className="web-settings-hint">Import Skills and MCP servers from a backup.</p>
        )}
      </div>
    </aside>
  );
}
