import React from 'react';
import { useStore, updateSettings, toggleSettings } from '../store';
import { themes } from '../themes';

export function SettingsPanel() {
  const { settingsVisible, settings } = useStore();

  if (!settingsVisible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) toggleSettings();
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
        </div>
        <div className="settings-footer">
          <span className="settings-hint">Press <kbd>⌘,</kbd> to toggle</span>
        </div>
      </div>
    </div>
  );
}
