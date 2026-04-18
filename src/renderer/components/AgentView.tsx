import React from 'react';
import type { AgentProvider } from '@shared/types';

interface AgentViewProps {
  tabId: string;
  projectId: string;
  provider: AgentProvider;
  visible: boolean;
}

export function AgentView({ tabId, projectId, provider, visible }: AgentViewProps) {
  if (!visible) return null;

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
