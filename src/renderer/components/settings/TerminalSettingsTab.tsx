import React from 'react';
import { themes } from '../../themes';
import type { AppSettings, LogLevel } from '@shared/types';
import { formatBytes } from '../../utils/format-bytes';

interface Props {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
  pathError: string | null;
  setPathError: (v: string | null) => void;
  logsPath: string;
  logsSize: { totalBytes: number; fileCount: number } | null;
  refreshLogsSize: () => void;
}

export function TerminalSettingsTab({ draft, updateDraft, pathError, setPathError, logsPath, logsSize, refreshLogsSize }: Props) {
  return (
    <>
      <div className="settings-section-title">Appearance</div>
      <div className="settings-group">
        <label className="settings-label">Theme</label>
        <select
          className="settings-select"
          value={draft.themeName}
          onChange={(e) => updateDraft({ themeName: e.target.value })}
        >
          {themes.map((t) => (
            <option key={t.name} value={t.name}>{t.label}</option>
          ))}
        </select>
      </div>

      <div className="settings-group">
        <label className="settings-label">Font Size</label>
        <input
          className="settings-input"
          type="number"
          min={8}
          max={32}
          value={draft.fontSize}
          onChange={(e) => updateDraft({ fontSize: Number(e.target.value) })}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Font Family</label>
        <input
          className="settings-input settings-input-wide"
          type="text"
          value={draft.fontFamily}
          onChange={(e) => updateDraft({ fontFamily: e.target.value })}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Scrollback Lines</label>
        <input
          className="settings-input"
          type="number"
          min={100}
          max={100000}
          step={500}
          value={draft.scrollback}
          onChange={(e) => updateDraft({ scrollback: Number(e.target.value) })}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Default Max Tabs</label>
        <input
          className="settings-input"
          type="number"
          min={1}
          max={20}
          value={draft.defaultMaxTabs}
          onChange={(e) => updateDraft({ defaultMaxTabs: Number(e.target.value) })}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Max Upload Size (MB)</label>
        <input
          className="settings-input"
          type="number"
          min={1}
          max={2048}
          value={draft.maxUploadSizeMB}
          onChange={(e) => updateDraft({ maxUploadSizeMB: Number(e.target.value) })}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Unicode 11</label>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={draft.unicode11 ?? false}
            onChange={(e) => updateDraft({ unicode11: e.target.checked })}
          />
          {' '}Enable
        </label>
      </div>
      <div className="settings-sub-hint">Better emoji/CJK width, may cause display issues with some prompts</div>

      <div className="settings-group">
        <label className="settings-label">Default Local Path</label>
        <input
          className="settings-input settings-input-wide"
          type="text"
          value={draft.defaultLocalPath || ''}
          onChange={(e) => { updateDraft({ defaultLocalPath: e.target.value || undefined }); setPathError(null); }}
          placeholder="~ (home directory)"
        />
        {pathError && <div className="settings-path-error">{pathError}</div>}
      </div>

      <div className="settings-divider" />
      <div className="settings-section-title">Logs</div>
      <div className="settings-group">
        <label className="settings-label">Log Level</label>
        <select
          className="settings-select"
          value={draft.logLevel}
          onChange={(e) => updateDraft({ logLevel: e.target.value as LogLevel })}
        >
          <option value="off">Off</option>
          <option value="error">Error</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <button
          className="conn-btn conn-btn-cancel"
          onClick={async () => {
            await window.shelfApi.logs.clear();
            refreshLogsSize();
          }}
        >
          Clear Logs
        </button>
        <span className="settings-logs-size">
          {logsSize === null
            ? '…'
            : `${formatBytes(logsSize.totalBytes)} · ${logsSize.fileCount} ${logsSize.fileCount === 1 ? 'file' : 'files'}`}
        </span>
      </div>
      <div className="settings-sub-hint">{logsPath}</div>
    </>
  );
}
