import React, { useState, useEffect, useCallback } from 'react';
import { useStore, updateSettings, toggleSettings } from '../store';
import { themes } from '../themes';
import { comboToLabel, recordCombo } from '../hooks/useKeybindings';
import type { AppSettings, KeybindingAction, KeybindingConfig, LogLevel } from '@shared/types';

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
  openCommandPicker: 'Quick Commands',
};

export function SettingsPanel() {
  const { settingsVisible, settings } = useStore();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [recordingAction, setRecordingAction] = useState<KeybindingAction | null>(null);
  const [dockerTestResult, setDockerTestResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [dockerTesting, setDockerTesting] = useState(false);

  // Reset draft when panel opens
  useEffect(() => {
    if (settingsVisible) {
      setDraft(settings);
      setRecordingAction(null);
      setDockerTestResult(null);
    }
  }, [settingsVisible, settings]);

  const updateDraft = (partial: Partial<AppSettings>) => {
    setDraft((d) => ({ ...d, ...partial }));
  };

  const handleRecord = useCallback((e: KeyboardEvent) => {
    if (!recordingAction) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = recordCombo(e);
    if (!combo) return;

    setDraft((d) => ({
      ...d,
      keybindings: { ...d.keybindings, [recordingAction]: combo },
    }));
    setRecordingAction(null);
  }, [recordingAction]);

  useEffect(() => {
    if (!recordingAction) return;
    window.addEventListener('keydown', handleRecord, true);
    return () => window.removeEventListener('keydown', handleRecord, true);
  }, [recordingAction, handleRecord]);

  if (!settingsVisible) return null;

  const handleSave = () => {
    updateSettings(draft);
    toggleSettings();
  };

  const handleCancel = () => {
    setDraft(settings);
    setRecordingAction(null);
    toggleSettings();
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleCancel();
  };

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      <div className="settings-panel">
        <div className="settings-header">
          <span>Settings</span>
          <button className="settings-close" onClick={handleCancel}>×</button>
        </div>
        <div className="settings-body">
          <div className="settings-section-title">Terminal</div>
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
              }}
            >
              Clear Logs
            </button>
          </div>

          <div className="settings-divider" />
          <div className="settings-section-title">Docker</div>
          <div className="settings-group">
            <label className="settings-label">Docker Path</label>
            <div className="settings-docker-row">
              <input
                className="settings-input settings-input-wide"
                type="text"
                value={draft.dockerPath || ''}
                onChange={(e) => { updateDraft({ dockerPath: e.target.value || undefined }); setDockerTestResult(null); }}
                placeholder="docker (uses PATH)"
              />
              <button
                className="conn-btn conn-btn-cancel"
                disabled={dockerTesting}
                onClick={async () => {
                  setDockerTesting(true);
                  setDockerTestResult(null);
                  const result = await window.shelfApi.docker.testPath(draft.dockerPath || 'docker');
                  setDockerTestResult(result);
                  setDockerTesting(false);
                }}
              >
                {dockerTesting ? 'Testing...' : 'Test'}
              </button>
            </div>
            {dockerTestResult && (
              <div className={`settings-docker-result ${dockerTestResult.ok ? 'ok' : 'fail'}`}>
                {dockerTestResult.ok
                  ? `Docker ${dockerTestResult.version}`
                  : dockerTestResult.error}
              </div>
            )}
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
                  : comboToLabel(draft.keybindings[action])}
              </button>
            </div>
          ))}
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={handleCancel}>Cancel</button>
          <button className="conn-btn conn-btn-next" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
