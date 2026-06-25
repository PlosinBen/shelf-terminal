import React from 'react';
import type { AppSettings, PmProviderType, ProviderModel } from '@shared/types';
import { PM_PROVIDERS, getModelsForProvider } from '@shared/types';
import { formatContextWindow, mergeModelLists, type ListStatus, type ListError } from './helpers';

interface Props {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
  detectedModels: ProviderModel[];
  listStatus: ListStatus;
  listError: ListError;
  refreshModelList: (baseURL: string) => void;
}

export function PmAgentSettingsTab({ draft, updateDraft, detectedModels, listStatus, listError, refreshModelList }: Props) {
  // Effective baseURL for current draft (user override > provider default).
  const pmProvider = draft.pmProvider?.provider;
  const pmMeta = pmProvider ? PM_PROVIDERS.find((p) => p.id === pmProvider) : undefined;
  const pmBaseURL = draft.pmProvider?.baseURL || pmMeta?.baseURL || '';
  const pmDynamic = !!pmMeta?.dynamicModelList;

  return (
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
        {/* Three-state hint for dynamic model list. See pm-agent#10. */}
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
        // Provider-specific informational hint (i18n-level UX, see agent-providers#1
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
  );
}
