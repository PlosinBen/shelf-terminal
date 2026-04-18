import React from 'react';
import type { AgentProvider } from '@shared/types';
import { emit, Events } from '../events';

const AGENT_PROVIDERS: { id: AgentProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'gemini', label: 'Gemini' },
];

interface AgentViewProps {
  tabId: string;
  projectId: string;
  projectIndex: number;
  provider?: AgentProvider;
  visible: boolean;
  onSelectProvider: (tabId: string, provider: AgentProvider) => void;
}

export function AgentView({ tabId, projectId, provider, visible, onSelectProvider }: AgentViewProps) {
  if (!visible) return null;

  if (!provider) {
    return (
      <div className="agent-view">
        <div className="agent-provider-picker">
          <span className="agent-picker-title">Select Agent Provider</span>
          <div className="agent-picker-options">
            {AGENT_PROVIDERS.map((p) => (
              <button
                key={p.id}
                className="agent-picker-btn"
                onClick={() => onSelectProvider(tabId, p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

  return (
    <div className="agent-view">
      <div className="agent-placeholder">
        <span className="agent-placeholder-icon">&#9672;</span>
        <span>{providerLabel} Agent</span>
        <span className="agent-placeholder-hint">Coming soon</span>
      </div>
    </div>
  );
}
