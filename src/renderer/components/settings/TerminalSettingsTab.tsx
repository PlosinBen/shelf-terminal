import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import type { AppSettings } from '@shared/types';

interface Props {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
}

export function TerminalSettingsTab({ draft, updateDraft }: Props) {
  const [families, setFamilies] = useState<string[]>([]);
  const [fontStatus, setFontStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [editingCustom, setEditingCustom] = useState(false);
  useEffect(() => {
    let active = true;
    async function loadFamilies() {
      try {
        const api = window as Window & { queryLocalFonts?(): Promise<{ family: string }[]> };
        const faces = await api.queryLocalFonts?.() ?? [];
        if (!active) return;
        const names = [...new Set(faces.map(face => face.family).filter(Boolean))];
        setFamilies(names.sort((a, b) => a.localeCompare(b)));
        setFontStatus(names.length ? 'ready' : 'unavailable');
      } catch {
        if (active) setFontStatus('unavailable');
      }
    }
    void loadFamilies();
    return () => { active = false; };
  }, []);
  const stackFor = (family: string) => `"${CSS.escape(family)}", monospace`;
  const knownStack = draft.fontFamily === DEFAULT_SETTINGS.fontFamily || families.some(name => stackFor(name) === draft.fontFamily);
  const choice = editingCustom || !knownStack ? 'custom' : draft.fontFamily;
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
        <label className="settings-label" htmlFor="terminal-font-family">Font Family</label>
        <select id="terminal-font-family" className="settings-select" value={choice} onChange={e => {
          const value = e.target.value;
          setEditingCustom(value === 'custom');
          if (value !== 'custom') updateDraft({ fontFamily: value });
        }}>
          <option value={DEFAULT_SETTINGS.fontFamily}>Terminal default</option>
          <optgroup label="Installed fonts">
            {families.map(name => <option key={name} value={stackFor(name)}>{name}</option>)}
          </optgroup>
          <option value="custom">Custom font stack…</option>
        </select>
      </div>
      {choice === 'custom' && <div className="settings-group">
        <label className="settings-label" htmlFor="terminal-font-stack">Custom font stack</label>
        <input id="terminal-font-stack" className="settings-input settings-input-wide" value={draft.fontFamily}
          onChange={e => updateDraft({ fontFamily: e.target.value })} />
      </div>}
      {fontStatus !== 'ready' && <div className="settings-sub-hint" role="status">
        {fontStatus === 'loading' ? 'Loading installed fonts…' : 'Installed fonts are unavailable. You can enter a custom font stack.'}
      </div>}

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
