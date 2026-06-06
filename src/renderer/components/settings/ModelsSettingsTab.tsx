import React, { useState } from 'react';
import type { AppSettings, ProviderModel } from '@shared/types';
import { PM_PROVIDERS, AGENT_PROVIDER_REGISTRY } from '@shared/types';
import { formatContextWindow } from './helpers';

interface Props {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
}

export function ModelsSettingsTab({ draft, updateDraft }: Props) {
  return (
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
