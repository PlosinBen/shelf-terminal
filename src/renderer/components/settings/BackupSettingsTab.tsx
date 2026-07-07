import { useEffect, useState, useCallback } from 'react';
import type { BackupListResult, BackupItemSummary } from '@shared/config-backup';
import { ImportSection } from './ImportSection';

// Settings → Backup: App-Level Config Backup & Copy (Backup half).
//   Backup = snapshot the ticked live items → THIS machine's remote branch.
//   One-way (live → my branch), never touches live; per-item tick is the leak
//   gate. The checklist pre-ticks items already in the branch (unticking removes
//   them on the next snapshot); new/never-backed-up items start unticked.
//   (Import — copy from another machine's branch into live — is a later phase.)

export function BackupSettingsTab() {
  const [data, setData] = useState<BackupListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Bind form (shown when this machine has no remote yet).
  const [remoteUrl, setRemoteUrl] = useState('');
  const [machineLabel, setMachineLabel] = useState('');
  const [bindError, setBindError] = useState<string | null>(null);
  const [mode, setMode] = useState<'backup' | 'import'>('backup');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.shelfApi.configBackup.list();
      setData(res);
      setSelected(new Set(res.backedUp));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onBind = async () => {
    setBindError(null);
    setBusy(true);
    try {
      const res = await window.shelfApi.configBackup.bind({ remoteUrl, machineLabel });
      if (res.ok) {
        setRemoteUrl('');
        setMachineLabel('');
        await refresh();
      } else {
        setBindError(res.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const onUnbind = async () => {
    const ok = await window.shelfApi.dialog.confirm(
      'Unbind backup remote',
      'Stop backing up from this machine? Your existing backup branch is left untouched on the remote.',
      'Unbind',
    );
    if (!ok) return;
    await window.shelfApi.configBackup.unbind();
    setStatus(null);
    await refresh();
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onBackup = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await window.shelfApi.configBackup.run([...selected]);
      if (res.ok) {
        setStatus({
          kind: 'ok',
          text: res.pushed
            ? `Backed up ${res.itemCount} item(s) to ${res.branch}.`
            : 'Already up to date — nothing to push.',
        });
        await refresh();
      } else {
        setStatus({ kind: 'err', text: res.message });
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return <div className="web-settings"><p className="web-settings-hint">Loading…</p></div>;
  }

  // Unbound → show the bind form.
  if (data && !data.binding) {
    return (
      <div className="web-settings">
        <h3 className="web-settings-title">Config Backup</h3>
        <p className="web-settings-hint">
          Back up this machine's skills &amp; MCP servers to a git remote you own. Each machine
          publishes to its own branch — Shelf uses your machine's own git (and its credentials);
          it stores no token. Requires <code>git</code> installed and access to the remote.
        </p>
        <label className="backup-field">
          <span className="backup-field-label">Remote URL</span>
          <input
            className="backup-input"
            type="text"
            placeholder="git@github.com:me/shelf-backups.git"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
        </label>
        <label className="backup-field">
          <span className="backup-field-label">This machine's label</span>
          <input
            className="backup-input"
            type="text"
            placeholder="work-mac"
            value={machineLabel}
            onChange={(e) => setMachineLabel(e.target.value)}
          />
        </label>
        {bindError && <p className="backup-status backup-status-err">{bindError}</p>}
        <div className="backup-actions">
          <button
            className="conn-btn conn-btn-next"
            disabled={busy || !remoteUrl.trim() || !machineLabel.trim()}
            onClick={onBind}
          >
            {busy ? 'Checking…' : 'Bind remote'}
          </button>
        </div>
      </div>
    );
  }

  const items = data?.items ?? [];
  const skills = items.filter((i) => i.kind === 'skill');
  const mcp = items.filter((i) => i.kind === 'mcp');

  const renderGroup = (title: string, groupItems: BackupItemSummary[]) => (
    <>
      <h3 className="web-settings-title">{title}</h3>
      {groupItems.length === 0 ? (
        <p className="web-settings-hint">None on this machine.</p>
      ) : (
        <ul className="web-list">
          {groupItems.map((it) => (
            <li key={it.id} className="web-list-item">
              <label className="backup-check">
                <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
                <span className="web-list-main">{it.name}</span>
                {it.detail && <span className="web-list-sub">{it.detail}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="web-settings">
      <div className="backup-bound-header">
        <p className="web-settings-hint" style={{ margin: 0 }}>
          Backing up as <strong>{data?.binding?.machineLabel}</strong> → <code>{data?.binding?.remoteUrl}</code>
        </p>
        <button className="web-list-action" onClick={onUnbind}>Unbind</button>
      </div>

      <div className="backup-mode-toggle">
        <button
          className={`backup-mode-btn ${mode === 'backup' ? 'active' : ''}`}
          onClick={() => setMode('backup')}
        >
          Back up
        </button>
        <button
          className={`backup-mode-btn ${mode === 'import' ? 'active' : ''}`}
          onClick={() => setMode('import')}
        >
          Import
        </button>
      </div>

      {mode === 'import' ? <ImportSection /> : BackupBody()}
    </div>
  );

  function BackupBody() {
    return (
      <>
      {data && !data.remoteReadOk && (
        <p className="backup-status backup-status-err">
          Couldn't read your existing backup (offline?). Ticking here will define a fresh snapshot —
          items you leave unticked will be removed from your backup branch.
        </p>
      )}

      <p className="web-settings-hint">
        Ticked items are published as a snapshot to your branch. Unticking a previously backed-up
        item removes it on the next backup. Nothing here ever changes your live config.
      </p>

      {renderGroup('Skills', skills)}
      {renderGroup('MCP servers', mcp)}

      {status && (
        <p className={`backup-status ${status.kind === 'ok' ? 'backup-status-ok' : 'backup-status-err'}`}>
          {status.text}
        </p>
      )}

      <div className="backup-actions">
        <button className="conn-btn conn-btn-next" disabled={busy} onClick={onBackup}>
          {busy ? 'Backing up…' : `Back up ${selected.size} item(s)`}
        </button>
      </div>
      </>
    );
  }
}
