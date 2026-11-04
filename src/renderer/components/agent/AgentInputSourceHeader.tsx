import React from 'react';
import { AGENT_INPUT_SOURCE as S, type AgentInputSource } from '@shared/agent-input';

/** agent-ui#13: display send-time identity; never infer source from content or current Views. */
export function agentInputSourceLabel(source?: AgentInputSource): string | null {
  if (!source) return null;
  switch (source.kind) {
    case S.AGENT_VIEW: return null;
    case S.TELEGRAM: return 'Telegram';
    case S.AGENT: return `From ${source.displayName}`;
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown Agent input source: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function AgentInputSourceHeader({ source }: { source?: AgentInputSource }) {
  const label = agentInputSourceLabel(source);
  return label ? <span className="agent-msg-source">{label}</span> : null;
}
