import React, { useState } from 'react';

export interface AgentMsg {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error';
  content: string;
  provider?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  streaming?: boolean;
}

interface AgentMessageProps {
  message: AgentMsg;
}

function toolSummary(toolName?: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  if (toolName === 'Bash' && input.command) return String(input.command).slice(0, 80);
  if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') && input.file_path) return String(input.file_path);
  if (toolName === 'Grep' && input.pattern) return String(input.pattern).slice(0, 60);
  if (toolName === 'Glob' && input.pattern) return String(input.pattern).slice(0, 60);
  const first = Object.values(input)[0];
  if (typeof first === 'string') return first.slice(0, 60);
  return '';
}

export function AgentMessage({ message }: AgentMessageProps) {
  const [expanded, setExpanded] = useState(false);

  if (message.type === 'thinking') {
    const preview = message.content.slice(0, 80).replace(/\n/g, ' ');
    return (
      <div className="agent-msg agent-msg-thinking">
        <button className="agent-thinking-toggle" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-thinking-label">Thinking</span>
          {!expanded && <span className="agent-thinking-preview">{preview}</span>}
        </button>
        {expanded && <pre className="agent-thinking-content">{message.content}</pre>}
      </div>
    );
  }

  if (message.type === 'tool_use') {
    const summary = toolSummary(message.toolName, message.toolInput);
    return (
      <div className="agent-msg agent-msg-tool">
        <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-tool-name">{message.toolName}</span>
          {summary && !expanded && <span className="agent-tool-summary">{summary}</span>}
          {message.streaming && <span className="agent-tool-badge">running</span>}
        </div>
        {expanded && message.toolInput && (
          <pre className="agent-tool-content">{JSON.stringify(message.toolInput, null, 2)}</pre>
        )}
      </div>
    );
  }

  if (message.type === 'tool_result') {
    return (
      <div className="agent-msg agent-msg-tool-result">
        <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-tool-result-label">Result</span>
        </div>
        {expanded && <pre className="agent-tool-content">{message.content}</pre>}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="agent-msg agent-msg-user">
        <div className="agent-msg-content">{message.content}</div>
      </div>
    );
  }

  if (message.type === 'system') {
    return (
      <div className="agent-msg agent-msg-system">
        <span>{message.content}</span>
      </div>
    );
  }

  if (message.type === 'error') {
    return (
      <div className="agent-msg agent-msg-error">
        <span className="agent-error-label">Error:</span>
        <span>{message.content}</span>
      </div>
    );
  }

  const label = message.provider
    ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}:`
    : 'Assistant:';

  return (
    <div className="agent-msg agent-msg-assistant">
      <span className="agent-msg-label">{label}</span>
      <div className="agent-msg-content">
        {message.content}
        {message.streaming && <span className="agent-cursor" />}
      </div>
    </div>
  );
}
