import { useEffect, useState, useCallback } from 'react';
import type { BackupSource, BackupItemSummary, ImportItemPlan } from '@shared/config-backup';

// Import (copy) flow: pick a backup source (another machine's branch or your
// own), tick items, review what changes vs your live config (new / overwrite),
// resolve any differing items (replace or keep), then apply. Import is the only
// thing that writes live — always per-item, overwrite-confirmed.

export function ImportSection() {
  const [sources, setSources] = useState<BackupSource[] | null>(null);
  const [ref, setRef] = useState<string>('');
  const [items, setItems] = useState<BackupItemSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<ImportItemPlan[] | null>(null);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Per-session (never persisted): overwrite all ticked items without the
  // per-item diff review. Bypasses the overwrite-confirm protection → default OFF.
  const [replaceAll, setReplaceAll] = useState(false);

  useEffect(() => {
    window.shelfApi.configBackup.listSources().then(setSources).catch(() => setSources([]));
  }, []);

  const chooseSource = useCallback(async (r: string) => {
    setRef(r);
    setItems(null);
    setSelected(new Set());
    setPlan(null);
    setStatus(null);
    if (!r) return;
    const its = await window.shelfApi.configBackup.listImportItems(r);
    setItems(its);
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPlan(null);
  };

  const onReview = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const p = await window.shelfApi.configBackup.planImport(ref, [...selected]);
      setPlan(p);
      // Conflicted items default to "replace" (lean toward replace).
      const d: Record<string, boolean> = {};
      for (const item of p) if (item.hasConflict) d[item.id] = true;
      setDecisions(d);
    } finally {
      setBusy(false);
    }
  };

  const applyWith = async (decisionList: { id: string; replaceConflicts: boolean }[]) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await window.shelfApi.configBackup.applyImport(ref, decisionList);
      setStatus({
        kind: 'ok',
        text: `Imported ${res.skillsWritten} skill file(s) + ${res.mcpWritten} MCP server(s) into your live config.`,
      });
      setPlan(null);
      setSelected(new Set());
      // Re-read the source items so a repeat review reflects the new live state.
      if (ref) setItems(await window.shelfApi.configBackup.listImportItems(ref));
    } catch (err: any) {
      setStatus({ kind: 'err', text: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const onApply = () => {
    if (!plan) return;
    applyWith(plan.map((p) => ({ id: p.id, replaceConflicts: decisions[p.id] ?? true })));
  };

  // Bulk path: overwrite every ticked item, skipping the diff review.
  const onReplaceAll = () => applyWith([...selected].map((id) => ({ id, replaceConflicts: true })));

  if (sources === null) {
    return <p className="web-settings-hint">Loading backups…</p>;
  }
  if (sources.length === 0) {
    return <p className="web-settings-hint">No backups found on the remote yet. Back up from a machine first.</p>;
  }

  return (
    <div>
      <label className="backup-field">
        <span className="backup-field-label">Import from</span>
        <select className="backup-input" value={ref} onChange={(e) => chooseSource(e.target.value)}>
          <option value="">Choose a backup…</option>
          {sources.map((s) => (
            <option key={s.ref} value={s.ref}>
              {s.machineLabel}{s.isSelf ? ' (this machine)' : ''}
            </option>
          ))}
        </select>
      </label>

      {items && items.length === 0 && <p className="web-settings-hint">This backup has no items.</p>}

      {items && items.length > 0 && !plan && (
        <>
          <p className="web-settings-hint">Tick what to copy into this machine's live config.</p>
          <ul className="web-list">
            {items.map((it) => (
              <li key={it.id} className="web-list-item">
                <label className="backup-check">
                  <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
                  <span className="web-list-main">{it.name}</span>
                  <span className="web-list-sub">{it.kind}{it.detail ? ` · ${it.detail}` : ''}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="import-replaceall">
            <input type="checkbox" checked={replaceAll} onChange={(e) => setReplaceAll(e.target.checked)} />
            Replace all existing (overwrite without reviewing)
          </label>
          <div className="backup-actions">
            {replaceAll ? (
              <button className="conn-btn conn-btn-next" disabled={busy || selected.size === 0} onClick={onReplaceAll}>
                {busy ? 'Importing…' : 'Import (replace all)'}
              </button>
            ) : (
              <button className="conn-btn conn-btn-next" disabled={busy || selected.size === 0} onClick={onReview}>
                {busy ? 'Reviewing…' : 'Review changes'}
              </button>
            )}
          </div>
        </>
      )}

      {plan && (
        <>
          <h3 className="web-settings-title">Review</h3>
          {plan.length === 0 ? (
            <p className="web-settings-hint">Nothing selected.</p>
          ) : (
            plan.map((item) => (
              <div key={item.id} className="import-review-item">
                <div className="import-review-head">
                  <span className="web-list-main">{item.name}</span>
                  <span className="web-list-sub">{item.kind}</span>
                  {item.hasConflict && (
                    <label className="import-replace-toggle">
                      <input
                        type="checkbox"
                        checked={decisions[item.id] ?? true}
                        onChange={(e) => setDecisions((d) => ({ ...d, [item.id]: e.target.checked }))}
                      />
                      Replace my version
                    </label>
                  )}
                </div>
                <ul className="import-entry-list">
                  {item.entries.map((en) => (
                    <li key={en.path || '(server)'} className={`import-entry import-entry-${en.change}`}>
                      <span className="import-entry-path">{en.path || 'server config'}</span>
                      <span className="import-entry-change">{en.change}</span>
                      {en.change === 'differs' && !en.binary && (
                        <div className="import-diff">
                          <pre className="import-diff-live" title="your version">{en.live}</pre>
                          <pre className="import-diff-backup" title="backup version">{en.backup}</pre>
                        </div>
                      )}
                      {en.change === 'differs' && en.binary && (
                        <span className="web-list-sub"> (binary — no preview)</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          <div className="backup-actions">
            <button className="web-list-action" onClick={() => setPlan(null)}>Back</button>
            <button className="conn-btn conn-btn-next" disabled={busy || plan.length === 0} onClick={onApply}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </>
      )}

      {status && (
        <p className={`backup-status ${status.kind === 'ok' ? 'backup-status-ok' : 'backup-status-err'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}
