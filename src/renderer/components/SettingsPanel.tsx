import { useState, useEffect, useCallback } from 'react';
import { useStore, updateSettings, toggleSettings } from '../store';
import { recordCombo } from '../hooks/useKeybindings';
import type { AppSettings, KeybindingAction, ProviderModel } from '@shared/types';
import { PM_PROVIDERS } from '@shared/types';
import { type ListStatus, type ListError } from './settings/helpers';
import { TerminalSettingsTab } from './settings/TerminalSettingsTab';
import { AgentSettingsTab } from './settings/AgentSettingsTab';
import { ModelsSettingsTab } from './settings/ModelsSettingsTab';
import { PmAgentSettingsTab } from './settings/PmAgentSettingsTab';
import { ShortcutsSettingsTab } from './settings/ShortcutsSettingsTab';

type SettingsTab = 'terminal' | 'agent' | 'models' | 'pm' | 'shortcuts';

export function SettingsPanel() {
  const { settingsVisible, settings } = useStore();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>('terminal');
  const [recordingAction, setRecordingAction] = useState<KeybindingAction | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [logsPath, setLogsPath] = useState<string>('');
  const [logsSize, setLogsSize] = useState<{ totalBytes: number; fileCount: number } | null>(null);

  // Dynamic model discovery for providers with `dynamicModelList` (e.g. ollama).
  // Hits GET <baseURL>/models via main-process `pm.listModels` IPC; result is
  // merged with user-defined custom entries from `providerModels`. See
  // pm-agent#10.
  const [detectedModels, setDetectedModels] = useState<ProviderModel[]>([]);
  const [listStatus, setListStatus] = useState<ListStatus>('idle');
  const [listError, setListError] = useState<ListError>(null);

  const refreshLogsSize = useCallback(() => {
    setLogsSize(null);
    window.shelfApi.logs.size().then(setLogsSize).catch(() => setLogsSize({ totalBytes: 0, fileCount: 0 }));
  }, []);

  // Reset draft when panel opens
  useEffect(() => {
    if (settingsVisible) {
      setDraft(settings);
      setActiveTab('terminal');
      setRecordingAction(null);
      setPathError(null);
      window.shelfApi.app.logsPath().then(setLogsPath);
      refreshLogsSize();
    }
  }, [settingsVisible, settings, refreshLogsSize]);

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

  // Effective baseURL for current draft (user override > provider default).
  const pmProvider = draft.pmProvider?.provider;
  const pmMeta = pmProvider ? PM_PROVIDERS.find((p) => p.id === pmProvider) : undefined;
  const pmBaseURL = draft.pmProvider?.baseURL || pmMeta?.baseURL || '';
  const pmDynamic = !!pmMeta?.dynamicModelList;

  const refreshModelList = useCallback(async (baseURL: string) => {
    setListStatus('loading');
    setListError(null);
    const res = await window.shelfApi.pm.listModels(baseURL);
    if (res.ok) {
      setDetectedModels(res.models);
      setListStatus(res.models.length === 0 ? 'empty' : 'success');
    } else {
      setDetectedModels([]);
      setListStatus('error');
      setListError(res.error);
    }
  }, []);

  // Debounced auto-fetch on provider/baseURL change.
  useEffect(() => {
    if (!settingsVisible || !pmDynamic || !pmBaseURL) {
      setDetectedModels([]);
      setListStatus('idle');
      setListError(null);
      return;
    }
    const handle = setTimeout(() => {
      refreshModelList(pmBaseURL);
    }, 500);
    return () => clearTimeout(handle);
  }, [settingsVisible, pmDynamic, pmBaseURL, refreshModelList]);

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
            <button className={`settings-tab ${activeTab === 'agent' ? 'active' : ''}`} onClick={() => setActiveTab('agent')}>Agent</button>
            <button className={`settings-tab ${activeTab === 'models' ? 'active' : ''}`} onClick={() => setActiveTab('models')}>Models</button>
            <button className={`settings-tab ${activeTab === 'pm' ? 'active' : ''}`} onClick={() => setActiveTab('pm')}>PM Agent</button>
            <button className={`settings-tab ${activeTab === 'shortcuts' ? 'active' : ''}`} onClick={() => setActiveTab('shortcuts')}>Shortcuts</button>
          </div>
          <div className="settings-body">
            {activeTab === 'terminal' && (
              <TerminalSettingsTab
                draft={draft}
                updateDraft={updateDraft}
                pathError={pathError}
                setPathError={setPathError}
                logsPath={logsPath}
                logsSize={logsSize}
                refreshLogsSize={refreshLogsSize}
              />
            )}

            {activeTab === 'agent' && (
              <AgentSettingsTab draft={draft} updateDraft={updateDraft} />
            )}

            {activeTab === 'models' && (
              <ModelsSettingsTab draft={draft} updateDraft={updateDraft} />
            )}

            {activeTab === 'pm' && (
              <PmAgentSettingsTab
                draft={draft}
                updateDraft={updateDraft}
                detectedModels={detectedModels}
                listStatus={listStatus}
                listError={listError}
                refreshModelList={refreshModelList}
              />
            )}

            {activeTab === 'shortcuts' && (
              <ShortcutsSettingsTab
                draft={draft}
                recordingAction={recordingAction}
                setRecordingAction={setRecordingAction}
              />
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
