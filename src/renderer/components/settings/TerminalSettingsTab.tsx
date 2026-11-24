import type { AppSettings } from '@shared/types';

interface Props {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
}

export function TerminalSettingsTab({ draft, updateDraft }: Props) {
  return (
    <>
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
    </>
  );
}
