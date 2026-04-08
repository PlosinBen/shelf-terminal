import React, { useState, useEffect, useCallback } from 'react';
import { useStore, updateSettings, toggleSettings } from '../store';
import { themes } from '../themes';
import { comboToLabel, recordCombo } from '../hooks/useKeybindings';
import type { KeybindingAction } from '../../shared/types';

const ACTION_LABELS: Record<KeybindingAction, string> = {
  toggleSidebar: 'Toggle Sidebar',
  newProject: 'New Project',
  closeProject: 'Close Project',
  newTab: 'New Tab',
  prevProject: 'Previous Project',
  nextProject: 'Next Project',
  prevTab: 'Previous Tab',
  nextTab: 'Next Tab',
  openSettings: 'Settings',
  search: 'Search',
  toggleSplit: 'Toggle Split',
};

export function SettingsPanel() {
  const { settingsVisible, settings } = useStore();
  const [recordingAction, setRecordingAction] = useState<KeybindingAction | null>(null);

  const handleRecord = useCallback((e: KeyboardEvent) => {
    if (!recordingAction) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = recordCombo(e);
    if (!combo) return;

    const newBindings = { ...settings.keybindings, [recordingAction]: combo };
    updateSettings({ keybindings: newBindings });
    setRecordingAction(null);
  }, [recordingAction, settings.keybindings]);

  useEffect(() => {
    if (!recordingAction) return;
    window.addEventListener('keydown', handleRecord, true);
    return () => window.removeEventListener('keydown', handleRecord, true);
  }, [recordingAction, handleRecord]);

  if (!settingsVisible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setRecordingAction(null);
      toggleSettings();
    }
  };

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      <div className="settings-panel">
        <div className="settings-header">
          <span>Settings</span>
          <button className="settings-close" onClick={toggleSettings}>×</button>
        </div>
        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Theme</label>
            <select
              className="settings-select"
              value={settings.themeName}
              onChange={(e) => updateSettings({ themeName: e.target.value })}
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
              value={settings.fontSize}
              onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Font Family</label>
            <input
              className="settings-input settings-input-wide"
              type="text"
              value={settings.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
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
              value={settings.scrollback}
              onChange={(e) => updateSettings({ scrollback: Number(e.target.value) })}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Default Max Tabs</label>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={20}
              value={settings.defaultMaxTabs}
              onChange={(e) => updateSettings({ defaultMaxTabs: Number(e.target.value) })}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Log Level</label>
            <select
              className="settings-select"
              value={settings.logLevel}
              onChange={(e) => updateSettings({ logLevel: e.target.value as any })}
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
              }}
            >
              Clear Logs
            </button>
          </div>

          <div className="settings-divider" />

          <div className="settings-section-title">Keyboard Shortcuts</div>
          {(Object.keys(ACTION_LABELS) as KeybindingAction[]).map((action) => (
            <div className="settings-group" key={action}>
              <label className="settings-label">{ACTION_LABELS[action]}</label>
              <button
                className={`keybinding-btn ${recordingAction === action ? 'recording' : ''}`}
                onClick={() => setRecordingAction(recordingAction === action ? null : action)}
              >
                {recordingAction === action
                  ? 'Press key combo...'
                  : comboToLabel(settings.keybindings[action])}
              </button>
            </div>
          ))}
        </div>
        <div className="settings-footer">
          <span className="settings-hint">Click a shortcut to rebind</span>
        </div>
      </div>
    </div>
  );
}
