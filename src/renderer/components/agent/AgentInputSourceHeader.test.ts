import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AGENT_INPUT_SOURCE as S } from '@shared/agent-input';
import { AgentInputSourceHeader, agentInputSourceLabel } from './AgentInputSourceHeader';

describe('Agent input source presentation', () => {
  it('leaves human input and legacy messages without a source unlabelled', () => {
    expect(agentInputSourceLabel()).toBeNull();
    expect(agentInputSourceLabel({ kind: S.AGENT_VIEW })).toBeNull();
    expect(renderToStaticMarkup(React.createElement(AgentInputSourceHeader))).toBe('');
  });
  it('labels Telegram and uses the Agent send-time name without provider lookup', () => {
    expect(agentInputSourceLabel({ kind: S.TELEGRAM })).toBe('Telegram');
    expect(agentInputSourceLabel({ kind: S.AGENT, agentViewId: 'stable-view', displayName: 'Research / Copilot' })).toBe('From Research / Copilot');
  });
  it('renders source names as text, never markup or message content', () => {
    const html = renderToStaticMarkup(React.createElement(AgentInputSourceHeader, { source: { kind: S.AGENT, agentViewId: 'view', displayName: '<script>unsafe</script>' } }));
    expect(html).toContain('From &lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('agent-msg-source');
  });
});
