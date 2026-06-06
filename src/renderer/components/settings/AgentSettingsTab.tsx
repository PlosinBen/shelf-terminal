import React from 'react';
import type { AppSettings, AgentDisplayMode } from '@shared/types';
import { AGENT_DISPLAY_KEYS, DEFAULT_AGENT_DISPLAY } from '@shared/types';

interface Props {
  draft: AppSettings;
  updateDraft: (partial: Partial<AppSettings>) => void;
}

export function AgentSettingsTab({ draft, updateDraft }: Props) {
  return (
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
  );
}
