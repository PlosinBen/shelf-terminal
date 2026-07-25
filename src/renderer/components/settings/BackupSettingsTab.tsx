import { useEffect, useState, useCallback } from 'react';
import type { BackupListResult, BackupItemSummary } from '@shared/config-backup';
import { ImportSection } from './ImportSection';

// Settings → Backup: App-Level Config Backup & Copy.
//   Two independent halves on one page:
//   1. Remote settings (URL + this machine's label) — just settings, saved
//      verbatim with no validation. Any real problem surfaces at Back up time.
//   2. Back up / Import — snapshot the ticked live items → this machine's
//      branch (Backup), or copy a chosen branch into live (Import). Per-item
//      tick is the leak gate; the checklist pre-ticks from machine-local intent.

export function BackupSettingsTab() {
  const [data, setData] = useState<BackupListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [mode, setMode] = useState<'backup' | 'import'>('backup');

  // Remote settings inputs — seeded from the saved binding (label falls back to
  // the sanitized hostname for a machine that has never set one).
  const [remoteUrl, setRemoteUrl] = useState('');
  const [machineLabel, setMachineLabel] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.shelfApi.configBackup.list();
      setData(res);
      setSelected(new Set(res.intent));
      setRemoteUrl(res.binding?.remoteUrl ?? '');
      setMachineLabel(res.binding?.machineLabel ?? res.suggestedLabel);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const savedUrl = data?.binding?.remoteUrl ?? '';
  const savedLabel = data?.binding?.machineLabel ?? data?.suggestedLabel ?? '';
  const dirty = remoteUrl !== savedUrl || machineLabel !== savedLabel;

  const onSaveSettings = async () => {
    setBusy(true);
    setSaved(false);
    try {
      await window.shelfApi.configBackup.saveSettings({ remoteUrl, machineLabel });
      await refresh();
      setSaved(true);
    } finally {
      setBusy(false);
    }
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
                <span className="backup-check-text">
                  <span className="web-list-main">{it.name}</span>
                  {it.detail && <span className="web-list-sub">{it.detail}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="web-settings">
      <h3 className="web-settings-title">Config Backup</h3>
      <p className="web-settings-hint">
        Back up this machine's skills &amp; MCP servers to a git remote you own. Each machine
        publishes to its own branch — Shelf uses your machine's own git (and its credentials);
        it stores no token.
      </p>

      <label className="backup-field">
        <span className="backup-field-label">Remote URL</span>
        <input
          className="backup-input"
          type="text"
          placeholder="git@github.com:me/shelf-backups.git"
          value={remoteUrl}
          onChange={(e) => { setRemoteUrl(e.target.value); setSaved(false); }}
        />
      </label>
      <label className="backup-field">
        <span className="backup-field-label">This machine's label</span>
        <input
          className="backup-input"
          type="text"
          placeholder="work-mac"
          value={machineLabel}
          onChange={(e) => { setMachineLabel(e.target.value); setSaved(false); }}
        />
        <span className="backup-field-hint">Display name only (shown when importing on other machines).</span>
      </label>
      <div className="backup-actions">
        {saved && !dirty && <span className="backup-status backup-status-ok">Saved.</span>}
        <button className="conn-btn conn-btn-next" disabled={busy || !dirty} onClick={onSaveSettings}>
          Save settings
        </button>
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
