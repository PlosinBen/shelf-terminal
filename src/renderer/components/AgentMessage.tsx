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

export function AgentMessage({ message }: AgentMessageProps) {
  const [expanded, setExpanded] = useState(false);

  if (message.type === 'thinking') {
    return (
      <div className="agent-msg agent-msg-thinking">
        <button className="agent-thinking-toggle" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          Thinking
        </button>
        {expanded && <div className="agent-thinking-content">{message.content}</div>}
      </div>
    );
  }

  if (message.type === 'tool_use') {
    return (
      <div className="agent-msg agent-msg-tool">
        <button className="agent-tool-toggle" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-tool-name">{message.toolName}</span>
          {message.streaming && <span className="agent-tool-running">running</span>}
        </button>
        {expanded && message.toolInput && (
          <pre className="agent-tool-input">{JSON.stringify(message.toolInput, null, 2)}</pre>
        )}
      </div>
    );
  }

  if (message.type === 'tool_result') {
    return (
      <div className="agent-msg agent-msg-tool-result">
        <button className="agent-tool-toggle" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          Result
        </button>
        {expanded && <pre className="agent-tool-input">{message.content}</pre>}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="agent-msg agent-msg-user">
        <span className="agent-msg-label">You:</span>
        <div className="agent-msg-content">{message.content}</div>
      </div>
    );
  }

  if (message.type === 'system') {
    return (
      <div className="agent-msg agent-msg-system">
        <span className="agent-msg-content">{message.content}</span>
      </div>
    );
  }

  if (message.type === 'error') {
    return (
      <div className="agent-msg agent-msg-error">
        <span className="agent-msg-content">{message.content}</span>
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
        {message.streaming && <span className="agent-cursor">&#9608;</span>}
      </div>
    </div>
  );
}
