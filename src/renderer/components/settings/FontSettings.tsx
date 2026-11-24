import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '@shared/defaults';
import type { AppSettings } from '@shared/types';

interface PickerProps {
  label: string;
  id: string;
  families: string[];
  value: string;
  defaultValue: string;
  fallback: 'sans-serif' | 'monospace';
  onChange: (value: string) => void;
}

function FontPicker({ label, id, families, value, defaultValue, fallback, onChange }: PickerProps) {
  const [editingCustom, setEditingCustom] = useState(false);
  const stackFor = (family: string) => `"${CSS.escape(family)}", ${fallback}`;
  const known = value === defaultValue || families.some(name => stackFor(name) === value);
  const custom = editingCustom || !known;
  return <>
    <div className="settings-group">
      <label className="settings-label" htmlFor={id}>{label}</label>
      <select id={id} className="settings-select" value={custom ? 'custom' : value} onChange={event => {
        const next = event.target.value;
        setEditingCustom(next === 'custom');
        if (next !== 'custom') onChange(next);
      }}>
        <option value={defaultValue}>Default</option>
        <optgroup label="Installed fonts">
          {families.map(name => <option key={name} value={stackFor(name)}>{name}</option>)}
        </optgroup>
        <option value="custom">Custom font stack…</option>
      </select>
    </div>
    {custom && <div className="settings-group">
      <label className="settings-label" htmlFor={id + '-stack'}>{label} stack</label>
      <input id={id + '-stack'} className="settings-input settings-input-wide" value={value}
        onChange={event => onChange(event.target.value)} />
    </div>}
  </>;
}

export function FontSettings({ draft, updateDraft }: {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
}) {
  const [families, setFamilies] = useState<string[]>([]);
  const [fontStatus, setFontStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
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
  return <>
    <FontPicker label="Interface Font" id="interface-font" families={families} fallback="sans-serif"
      value={draft.interfaceFontFamily} defaultValue={DEFAULT_SETTINGS.interfaceFontFamily}
      onChange={interfaceFontFamily => updateDraft({ interfaceFontFamily })} />
    <FontPicker label="Monospace Font" id="monospace-font" families={families} fallback="monospace"
      value={draft.fontFamily} defaultValue={DEFAULT_SETTINGS.fontFamily}
      onChange={fontFamily => updateDraft({ fontFamily })} />
      {fontStatus !== 'ready' && <div className="settings-sub-hint" role="status">
        {fontStatus === 'loading' ? 'Loading installed fonts…' : 'Installed fonts are unavailable. You can enter a custom font stack.'}
      </div>}
  </>;
}
