import React, { useState, useEffect, useCallback } from 'react';
import { useStore, updateSettings, toggleSettings } from '../store';
import { themes } from '../themes';
import { comboToLabel, recordCombo } from '../hooks/useKeybindings';
import type { AppSettings, KeybindingAction, KeybindingConfig, LogLevel } from '@shared/types';

const ACTION_LABELS: Record<KeybindingAction, string> = {
  toggleSidebar: 'Toggle Sidebar',
  newProject: 'New Project',
  removeProject: 'Remove Project',
  newTab: 'New Tab',
  prevProject: 'Previous Project',
  nextProject: 'Next Project',
  prevTab: 'Previous Tab',
  nextTab: 'Next Tab',
  openSettings: 'Settings',
  search: 'Search',
  toggleSplit: 'Toggle Split',
  openCommandPicker: 'Quick Commands',
  toggleDevTools: 'Dev Tools',
};

type SettingsTab = 'terminal' | 'pm' | 'shortcuts';

export function SettingsPanel() {
  const { settingsVisible, settings } = useStore();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>('terminal');
  const [recordingAction, setRecordingAction] = useState<KeybindingAction | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [logsPath, setLogsPath] = useState<string>('');

  // Reset draft when panel opens
  useEffect(() => {
    if (settingsVisible) {
      setDraft(settings);
      setActiveTab('terminal');
      setRecordingAction(null);
      setPathError(null);
      window.shelfApi.app.logsPath().then(setLogsPath);
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

  const handleSave = async () => {
    if (draft.defaultLocalPath) {
      const result = await window.shelfApi.connector.listDir({ type: 'local' }, draft.defaultLocalPath);
      if (result.error) {
        setPathError(`Path does not exist: ${draft.defaultLocalPath}`);
        setActiveTab('terminal');
        return;
      }
    }
    updateSettings(draft);
    toggleSettings();
  };

  const handleCancel = () => {
    setDraft(settings);
    setRecordingAction(null);
    toggleSettings();
  };

  useEffect(() => {
    if (!settingsVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !recordingAction) {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [settingsVisible, recordingAction, settings]);

  if (!settingsVisible) return null;

  return (
    <div className="settings-overlay">
      <div className="settings-panel">
        <div className="settings-header">
          <span>Settings</span>
          <button className="settings-close" onClick={handleCancel}>×</button>
        </div>
        <div className="settings-layout">
          <div className="settings-tabs">
            <button className={`settings-tab ${activeTab === 'terminal' ? 'active' : ''}`} onClick={() => setActiveTab('terminal')}>Terminal</button>
            <button className={`settings-tab ${activeTab === 'pm' ? 'active' : ''}`} onClick={() => setActiveTab('pm')}>PM Agent</button>
            <button className={`settings-tab ${activeTab === 'shortcuts' ? 'active' : ''}`} onClick={() => setActiveTab('shortcuts')}>Shortcuts</button>
          </div>
          <div className="settings-body">
            {activeTab === 'terminal' && (
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
                    }}
                  >
                    Clear Logs
                  </button>
                </div>
                <div className="settings-sub-hint">{logsPath}</div>

              </>
            )}

            {activeTab === 'pm' && (
              <>
                <div className="settings-section-title">Provider</div>
                <div className="settings-group">
                  <label className="settings-label">Base URL</label>
                  <input
                    className="settings-input settings-input-wide"
                    type="text"
                    value={draft.pmProvider?.baseUrl || ''}
                    onChange={(e) => updateDraft({
                      pmProvider: { ...draft.pmProvider ?? { baseUrl: '', apiKey: '', model: '' }, baseUrl: e.target.value },
                    })}
                    placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">API Key</label>
                  <input
                    className="settings-input settings-input-wide"
                    type="password"
                    value={draft.pmProvider?.apiKey || ''}
                    onChange={(e) => updateDraft({
                      pmProvider: { ...draft.pmProvider ?? { baseUrl: '', apiKey: '', model: '' }, apiKey: e.target.value },
                    })}
                    placeholder="API key"
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">Model</label>
                  <input
                    className="settings-input settings-input-wide"
                    type="text"
                    value={draft.pmProvider?.model || ''}
                    onChange={(e) => updateDraft({
                      pmProvider: { ...draft.pmProvider ?? { baseUrl: '', apiKey: '', model: '' }, model: e.target.value },
                    })}
                    placeholder="gemini-2.5-flash"
                  />
                </div>
                <div className="settings-sub-hint">
                  OpenAI-compatible chat/completions format. Base URL and model ID depend on your provider —
                  see{' '}
                  <a href="https://ai.google.dev/gemini-api/docs/openai" target="_blank" rel="noopener noreferrer">Gemini</a>
                  {' · '}
                  <a href="https://platform.openai.com/docs/api-reference" target="_blank" rel="noopener noreferrer">OpenAI</a>
                  {' · '}
                  <a href="https://docs.claude.com/en/api/openai-sdk" target="_blank" rel="noopener noreferrer">Anthropic</a>.
                </div>

                <div className="settings-divider" />
                <div className="settings-section-title">Telegram Bridge</div>
                <div className="settings-group">
                  <label className="settings-label">Bot Token</label>
                  <input
                    className="settings-input settings-input-wide"
                    type="password"
                    value={draft.telegram?.botToken || ''}
                    onChange={(e) => updateDraft({
                      telegram: { ...draft.telegram ?? { botToken: '', chatId: '' }, botToken: e.target.value },
                    })}
                    placeholder="123456:ABC-DEF..."
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">Chat ID</label>
                  <input
                    className="settings-input"
                    type="text"
                    value={draft.telegram?.chatId || ''}
                    onChange={(e) => updateDraft({
                      telegram: { ...draft.telegram ?? { botToken: '', chatId: '' }, chatId: e.target.value },
                    })}
                    placeholder="123456789"
                  />
                </div>
                <div className="settings-sub-hint">Send /start to your bot, then use @userinfobot to find your chat ID</div>
              </>
            )}

            {activeTab === 'shortcuts' && (
              <>
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
              </>
            )}
          </div>
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={handleCancel}>Cancel</button>
          <button className="conn-btn conn-btn-next" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
