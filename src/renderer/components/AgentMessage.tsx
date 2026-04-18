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
  cwd?: string;
}

interface AgentMessageProps {
  message: AgentMsg;
}

function stripCwd(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;
  if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1);
  return filePath;
}

function getToolSummary(toolName?: string, input?: Record<string, unknown>, cwd?: string): string {
  if (!input || !toolName) return '';
  switch (toolName) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read':
      const readPath = stripCwd(String(input.file_path ?? ''), cwd);
      if (input.offset || input.limit) return `${readPath}: #${input.offset ?? 0} - #${(Number(input.offset ?? 0) + Number(input.limit ?? 0))}`;
      return readPath;
    case 'Edit':
    case 'Write':
      return stripCwd(String(input.file_path ?? ''), cwd);
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Grep': {
      const pattern = String(input.pattern ?? '');
      const grepPath = input.path ? ` in ${stripCwd(String(input.path), cwd)}` : '';
      return pattern + grepPath;
    }
    case 'Task':
    case 'Agent':
      return String(input.description ?? input.prompt ?? '').slice(0, 80);
    case 'TodoWrite':
      return 'update tasks';
    default: {
      const first = Object.values(input)[0];
      if (typeof first === 'string') return first.slice(0, 60);
      return '';
    }
  }
}

function truncateLines(text: string, max: number): { lines: string[]; remaining: number } {
  const all = text.split('\n');
  if (all.length <= max) return { lines: all, remaining: 0 };
  return { lines: all.slice(0, max), remaining: all.length - max };
}

function ToolBody({ toolName, input, cwd }: { toolName?: string; input?: Record<string, unknown>; cwd?: string }) {
  if (!toolName || !input) return <pre className="agent-tool-content">{JSON.stringify(input, null, 2)}</pre>;

  switch (toolName) {
    case 'Bash': {
      const cmd = String(input.command ?? '');
      return <pre className="agent-tool-code">{cmd}</pre>;
    }

    case 'Read': {
      const filePath = stripCwd(String(input.file_path ?? ''), cwd);
      return <div className="agent-tool-file-path">{filePath}</div>;
    }

    case 'Edit': {
      const filePath = stripCwd(String(input.file_path ?? ''), cwd);
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      const oldLines = oldStr.split('\n');
      const newLines = newStr.split('\n');
      const maxLen = Math.max(oldLines.length, newLines.length);

      return (
        <>
          <div className="agent-tool-file-path">{filePath}</div>
          <div className="agent-diff-side">
            <div className="agent-diff-pane">
              {Array.from({ length: maxLen }, (_, i) => (
                <div key={i} className={`agent-diff-row ${i < oldLines.length ? 'agent-diff-del' : 'agent-diff-empty'}`}>
                  <span className="agent-diff-num">{i < oldLines.length ? i + 1 : ''}</span>
                  <span className="agent-diff-sign">{i < oldLines.length ? '-' : ''}</span>
                  <span className="agent-diff-text">{oldLines[i] ?? ''}</span>
                </div>
              ))}
            </div>
            <div className="agent-diff-pane">
              {Array.from({ length: maxLen }, (_, i) => (
                <div key={i} className={`agent-diff-row ${i < newLines.length ? 'agent-diff-add' : 'agent-diff-empty'}`}>
                  <span className="agent-diff-num">{i < newLines.length ? i + 1 : ''}</span>
                  <span className="agent-diff-sign">{i < newLines.length ? '+' : ''}</span>
                  <span className="agent-diff-text">{newLines[i] ?? ''}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      );
    }

    case 'Write': {
      const filePath = stripCwd(String(input.file_path ?? input.content ? (input.file_path ?? '') : ''), cwd);
      const content = String(input.content ?? '');
      const { lines, remaining } = truncateLines(content, 20);
      return (
        <>
          {filePath && <div className="agent-tool-file-path">{filePath}</div>}
          <div className="agent-tool-diff-inline">
            {lines.map((line, i) => (
              <div key={i} className="agent-diff-row agent-diff-add">
                <span className="agent-diff-sign">+</span>
                <span className="agent-diff-text">{line}</span>
              </div>
            ))}
            {remaining > 0 && <div className="agent-tool-truncated">... +{remaining} more lines</div>}
          </div>
        </>
      );
    }

    case 'Glob': {
      return <pre className="agent-tool-code">{String(input.pattern ?? '')}</pre>;
    }

    case 'Grep': {
      const pattern = String(input.pattern ?? '');
      const grepPath = input.path ? stripCwd(String(input.path), cwd) : null;
      return (
        <>
          {grepPath && <div className="agent-tool-file-path">in {grepPath}</div>}
          <pre className="agent-tool-code">{pattern}</pre>
        </>
      );
    }

    default:
      return <pre className="agent-tool-content">{JSON.stringify(input, null, 2)}</pre>;
  }
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
    const summary = getToolSummary(message.toolName, message.toolInput, message.cwd);
    const hasBody = message.toolName !== 'Read' || expanded;
    return (
      <div className="agent-msg agent-msg-tool">
        <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-tool-name">{message.toolName}</span>
          {summary && !expanded && <span className="agent-tool-summary">{summary}</span>}
          {message.streaming && <span className="agent-tool-badge">running</span>}
        </div>
        {expanded && <ToolBody toolName={message.toolName} input={message.toolInput} cwd={message.cwd} />}
      </div>
    );
  }

  if (message.type === 'tool_result') {
    if (!message.content) return null;
    const { lines, remaining } = truncateLines(message.content, 30);
    return (
      <div className="agent-msg agent-msg-tool-result">
        <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-tool-result-label">Result</span>
          {!expanded && <span className="agent-tool-summary">{message.content.slice(0, 60).replace(/\n/g, ' ')}</span>}
        </div>
        {expanded && (
          <pre className="agent-tool-code">
            {lines.join('\n')}
            {remaining > 0 && `\n... +${remaining} more lines`}
          </pre>
        )}
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
