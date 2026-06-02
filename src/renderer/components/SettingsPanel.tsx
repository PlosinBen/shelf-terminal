import React, { useState, useEffect, useCallback } from 'react';
import { useStore, updateSettings, toggleSettings } from '../store';
import { themes } from '../themes';
import { comboToLabel, recordCombo } from '../hooks/useKeybindings';
import type { AppSettings, KeybindingAction, KeybindingConfig, LogLevel, PmProviderType, ProviderModel, AgentDisplayMode } from '@shared/types';
import { PM_PROVIDERS, getModelsForProvider, AGENT_DISPLAY_KEYS, AGENT_PROVIDER_REGISTRY, DEFAULT_AGENT_DISPLAY } from '@shared/types';
import { formatBytes } from '../utils/format-bytes';

type ListStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';
type ListError = 'unreachable' | 'timeout' | 'parse_error' | null;

const ACTION_LABELS: Record<KeybindingAction, string> = {
  toggleProjectList: 'Toggle Project List',
  newProject: 'New Project',
  removeProject: 'Remove Project',
  newTab: 'New Tab',
  prevProject: 'Previous Project',
  nextProject: 'Next Project',
  prevTab: 'Previous Tab',
  nextTab: 'Next Tab',
  openSettings: 'Settings',
  search: 'Search',
  toggleSplitRight: 'Split Right',
  openCommandPicker: 'Quick Commands',
  toggleDevTools: 'Dev Tools',
  toggleNotes: 'Notes',
  togglePm: 'PM Agent',
  quickNote: 'Quick Note',
};

function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Merge detected + custom models, deduped by id. Custom overrides detected
 *  for the same id (lets user enrich auto-discovered entries with
 *  contextWindow / reasoning flag). */
function mergeModelLists(detected: ProviderModel[], custom: ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const m of detected) byId.set(m.id, m);
  for (const m of custom) byId.set(m.id, m); // custom wins
  return Array.from(byId.values());
}

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
  // merged with user-defined custom entries from `providerModels`. See D3-b in
  // .agent/features/pm-ollama-provider.md.
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
            )}

            {activeTab === 'agent' && (
              <>
                <div className="settings-section-title">History</div>
                <div className="settings-group">
                  <label className="settings-label">In-Memory Messages</label>
                  <input
                    className="settings-input"
                    type="number"
                    min={50}
                    max={10000}
                    step={50}
                    value={draft.agentInMemoryMaxMessages}
                    onChange={(e) => updateDraft({ agentInMemoryMaxMessages: Number(e.target.value) })}
                  />
                </div>
                <div className="settings-sub-hint">How many messages stay rendered. Higher values use more memory and slow input typing. Disk history is unbounded — older messages stay in IDB and (in future) can be loaded back on demand.</div>

                <div className="settings-group">
                  <label className="settings-label">Save Throttle (ms)</label>
                  <input
                    className="settings-input"
                    type="number"
                    min={0}
                    max={60000}
                    step={500}
                    value={draft.agentHistorySaveThrottleMs}
                    onChange={(e) => updateDraft({ agentHistorySaveThrottleMs: Number(e.target.value) })}
                  />
                </div>
                <div className="settings-sub-hint">How often the in-memory state flushes to disk. Lower = less data loss on crash, higher = fewer IDB writes.</div>

                <div className="settings-divider" />
                <div className="settings-section-title">Display</div>
                {AGENT_DISPLAY_KEYS.map(({ key, label, hint }) => (
                  <React.Fragment key={key}>
                    <div className="settings-group">
                      <label className="settings-label">{label}</label>
                      <select
                        className="settings-select"
                        value={draft.agentDisplay?.[key] ?? DEFAULT_AGENT_DISPLAY[key]}
                        onChange={(e) => updateDraft({
                          agentDisplay: { ...draft.agentDisplay, [key]: e.target.value as AgentDisplayMode },
                        })}
                      >
                        <option value="collapsed">Collapsed</option>
                        <option value="expanded">Expanded</option>
                      </select>
                    </div>
                    {hint && <div className="settings-sub-hint">{hint}</div>}
                  </React.Fragment>
                ))}
              </>
            )}

            {activeTab === 'models' && (
              <>
                <div className="settings-section-title">Models</div>
                <div className="project-edit-hint">Custom entries shown in PM Agent and Claude pickers. SDK-provided defaults are not listed here.</div>
                {[...PM_PROVIDERS, ...AGENT_PROVIDER_REGISTRY].map((p) => (
                  <ProviderModelsSection
                    key={p.id}
                    provider={p}
                    customModels={draft.providerModels?.[p.id] ?? []}
                    onChange={(models) => {
                      const next = { ...draft.providerModels };
                      if (models.length > 0) next[p.id] = models;
                      else delete next[p.id];
                      updateDraft({ providerModels: Object.keys(next).length > 0 ? next : undefined });
                    }}
                  />
                ))}
              </>
            )}

            {activeTab === 'pm' && (
              <>
                <div className="settings-section-title">Provider</div>
                <div className="settings-group">
                  <label className="settings-label">Provider</label>
                  <select
                    className="settings-input"
                    value={draft.pmProvider?.provider || ''}
                    onChange={(e) => {
                      const id = e.target.value as PmProviderType;
                      const meta = PM_PROVIDERS.find((p) => p.id === id);
                      updateDraft({
                        // Drop any previous baseURL override on provider switch — different
                        // provider, different default endpoint. User can re-enter if needed.
                        pmProvider: {
                          ...(draft.pmProvider ?? { provider: id, apiKey: '', model: '' }),
                          provider: id,
                          model: meta?.defaultModel ?? '',
                          baseURL: undefined,
                        },
                      });
                    }}
                  >
                    <option value="">Select...</option>
                    {PM_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                {pmProvider && (
                  <div className="settings-group">
                    <label className="settings-label">Base URL</label>
                    <input
                      className="settings-input settings-input-wide"
                      type="text"
                      value={draft.pmProvider?.baseURL || ''}
                      onChange={(e) => updateDraft({
                        pmProvider: {
                          ...(draft.pmProvider ?? { provider: pmProvider, apiKey: '', model: '' }),
                          baseURL: e.target.value || undefined,
                        },
                      })}
                      placeholder={pmMeta?.baseURL || '(provider default)'}
                    />
                  </div>
                )}
                <div className="settings-group">
                  <label className="settings-label">API Key</label>
                  <input
                    className="settings-input settings-input-wide"
                    type="password"
                    value={draft.pmProvider?.apiKey || ''}
                    onChange={(e) => updateDraft({
                      pmProvider: { ...draft.pmProvider ?? { provider: 'gemini', apiKey: '', model: '' }, apiKey: e.target.value },
                    })}
                    placeholder={pmDynamic ? 'Optional for local providers' : 'API key'}
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">Model</label>
                  <div className="settings-model-row">
                    <select
                      className="settings-input settings-input-wide"
                      value={draft.pmProvider?.model || ''}
                      onChange={(e) => updateDraft({
                        pmProvider: { ...draft.pmProvider ?? { provider: 'gemini', apiKey: '', model: '' }, model: e.target.value },
                      })}
                    >
                      <option value="">Select model...</option>
                      {(() => {
                        if (!pmProvider) return null;
                        const customList = getModelsForProvider(pmProvider, draft.providerModels);
                        const list = pmDynamic ? mergeModelLists(detectedModels, customList) : customList;
                        // Ensure currently-selected model is always an option, even if not in list yet
                        // (e.g. user has defaultModel='qwen3:8b' but hasn't pulled it; detected list
                        // is empty or fetching). Otherwise the <select> visually deselects.
                        const current = draft.pmProvider?.model;
                        const hasCurrent = current && list.some((m) => m.id === current);
                        const finalList = hasCurrent || !current ? list : [{ id: current }, ...list];
                        return finalList.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.contextWindow ? `${m.id} (${formatContextWindow(m.contextWindow)})` : m.id}
                          </option>
                        ));
                      })()}
                    </select>
                    {pmDynamic && (
                      <button
                        type="button"
                        className="settings-icon-btn"
                        title="Refresh model list"
                        onClick={() => pmBaseURL && refreshModelList(pmBaseURL)}
                        disabled={listStatus === 'loading' || !pmBaseURL}
                      >↻</button>
                    )}
                  </div>
                  {/* Three-state hint for dynamic model list. See D3-b in
                      .agent/features/pm-ollama-provider.md. */}
                  {pmDynamic && listStatus === 'loading' && (
                    <div className="settings-sub-hint">Loading models from {pmBaseURL}…</div>
                  )}
                  {pmDynamic && listStatus === 'error' && (
                    <div className="settings-sub-hint settings-sub-hint-warn">
                      {listError === 'timeout'
                        ? `Ollama at ${pmBaseURL} didn't respond in time.`
                        : listError === 'parse_error'
                          ? `Got unexpected response from ${pmBaseURL}. Is this an OpenAI-compatible endpoint?`
                          : `Cannot reach Ollama at ${pmBaseURL}. Is \`ollama serve\` running?`}
                    </div>
                  )}
                  {pmDynamic && listStatus === 'empty' && (
                    <div className="settings-sub-hint">
                      Ollama is running but has no models. Run{' '}
                      <code
                        className="settings-copy-code"
                        title="Click to copy"
                        onClick={() => navigator.clipboard?.writeText('ollama pull qwen3:8b')}
                      >ollama pull qwen3:8b</code>
                      {' '}in a terminal first.
                    </div>
                  )}
                </div>
                {pmProvider === 'ollama' && (
                  // Provider-specific informational hint (i18n-level UX, see DECISIONS #43
                  // exception). Background: ollama tool_call support is model-dependent —
                  // qwen2.5-coder emits JSON-as-text, qwen3:8b emits proper tool-call events.
                  // See GOTCHAS "Ollama: model 看似支援 tool_call、實測只吐 JSON text".
                  <div className="settings-sub-hint">
                    PM Agent needs native tool_call support. Verified working: <strong>qwen3:8b</strong>.
                    Some models (qwen2.5-coder) claim support but emit JSON-as-text.
                  </div>
                )}

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

function ProviderModelsSection({ provider, customModels, onChange }: {
  provider: { id: string; label: string; models: ProviderModel[] };
  customModels: ProviderModel[];
  onChange: (models: ProviderModel[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newCtx, setNewCtx] = useState('128000');
  const [newReasoning, setNewReasoning] = useState(false);

  const customIds = new Set(customModels.map((m) => m.id));

  const handleAdd = () => {
    const id = newId.trim();
    if (!id) return;
    const ctx = parseInt(newCtx, 10) || 128000;
    const entry: ProviderModel = { id, contextWindow: ctx, ...(newReasoning ? { reasoning: true } : {}) };
    const list = [...customModels];
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    onChange(list);
    setNewId('');
    setNewCtx('128000');
    setNewReasoning(false);
    setAdding(false);
  };

  const handleRemove = (modelId: string) => {
    onChange(customModels.filter((m) => m.id !== modelId));
  };

  return (
    <div className="settings-group" style={{ alignItems: 'flex-start' }}>
      <label className="settings-label" style={{ paddingTop: 3 }}>{provider.label}</label>
      <div className="custom-models-list" style={{ flex: 1 }}>
        {provider.models.map((m) => (
          <div key={m.id} className="custom-model-row">
            <span className="custom-model-id">{m.id}{m.reasoning && <span className="custom-model-reasoning">reasoning</span>}</span>
            <span className="custom-model-ctx">{m.contextWindow ? formatContextWindow(m.contextWindow) : '—'}</span>
          </div>
        ))}
        {customModels.filter((m) => !provider.models.some((d) => d.id === m.id)).map((m) => (
          <div key={m.id} className="custom-model-row">
            <span className="custom-model-id">{m.id}{m.reasoning && <span className="custom-model-reasoning">reasoning</span>}</span>
            <span className="custom-model-ctx">{m.contextWindow ? formatContextWindow(m.contextWindow) : '—'}</span>
            <button className="default-tab-remove" onClick={() => handleRemove(m.id)} title="Remove">×</button>
          </div>
        ))}
        {adding ? (
          <div className="custom-model-add-form">
            <div className="custom-model-add-row">
              <input className="settings-input" type="text" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="model-id" style={{ flex: 1 }} />
              <input className="settings-input" type="number" value={newCtx} onChange={(e) => setNewCtx(e.target.value)} placeholder="context window" style={{ width: 100 }} />
            </div>
            <div className="custom-model-add-row">
              <label className="settings-checkbox"><input type="checkbox" checked={newReasoning} onChange={(e) => setNewReasoning(e.target.checked)} /> Reasoning</label>
            </div>
            <div className="custom-model-add-row">
              <button className="conn-btn conn-btn-next" onClick={handleAdd} disabled={!newId.trim()}>Add</button>
              <button className="conn-btn conn-btn-cancel" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="default-tab-add" onClick={() => setAdding(true)}>+ Add Model</button>
        )}
      </div>
    </div>
  );
}
