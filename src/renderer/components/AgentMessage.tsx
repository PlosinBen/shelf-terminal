import React, { useState, useMemo } from 'react';
import { marked } from 'marked';
import { useStore } from '../store';
import type { AgentDisplayMode } from '@shared/types';

export interface AgentMsg {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'thinking' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  streaming?: boolean;
  provider?: string;
  timestamp: number;
}

marked.setOptions({ breaks: false, gfm: true });

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
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
    case 'bash':
      return String(input.command ?? '');
    case 'Read':
    case 'read_file':
      return stripCwd(String(input.file_path ?? input.path ?? ''), cwd);
    case 'Edit':
    case 'edit_file':
    case 'Write':
    case 'write_file':
      return stripCwd(String(input.file_path ?? input.path ?? ''), cwd);
    case 'list_directory':
      return stripCwd(String(input.path ?? ''), cwd);
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

  const name = toolName.toLowerCase();

  if (name === 'bash') {
    return <pre className="agent-tool-code">{String(input.command ?? '')}</pre>;
  }

  if (name === 'edit' || name === 'edit_file') {
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    return (
      <div className="agent-tool-diff-inline">
        {oldLines.map((line, i) => (
          <div key={`d${i}`} className="agent-diff-row agent-diff-del">
            <span className="agent-diff-sign">-</span>
            <span className="agent-diff-text">{line}</span>
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`a${i}`} className="agent-diff-row agent-diff-add">
            <span className="agent-diff-sign">+</span>
            <span className="agent-diff-text">{line}</span>
          </div>
        ))}
      </div>
    );
  }

  if (name === 'write' || name === 'write_file') {
    const content = String(input.content ?? '');
    const { lines, remaining } = truncateLines(content, 20);
    return (
      <div className="agent-tool-diff-inline">
        {lines.map((line, i) => (
          <div key={i} className="agent-diff-row agent-diff-add">
            <span className="agent-diff-sign">+</span>
            <span className="agent-diff-text">{line}</span>
          </div>
        ))}
        {remaining > 0 && <div className="agent-tool-truncated">... +{remaining} more lines</div>}
      </div>
    );
  }

  if (name === 'read' || name === 'read_file' || name === 'list_directory' || name === 'glob') {
    return null;
  }

  return <pre className="agent-tool-content">{JSON.stringify(input, null, 2)}</pre>;
}

interface Props {
  message: AgentMsg;
  cwd?: string;
}

export function AgentMessage({ message, cwd }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { settings } = useStore();

  const resolveDisplayMode = (key: string): AgentDisplayMode => {
    return settings.agentDisplay?.[key] ?? 'collapsed';
  };

  if (message.type === 'tool_use') {
    const toolKey = message.toolName ?? 'other';
    const toolMode = resolveDisplayMode(toolKey) ?? resolveDisplayMode('other');
    if (toolMode === 'hidden') return null;
    const isExpanded = expanded || toolMode === 'expanded';
    const summary = getToolSummary(message.toolName, message.toolInput, cwd);
    return (
      <div className="agent-msg agent-msg-tool">
        <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-tool-name">{message.toolName}</span>
          {summary && <span className={`agent-tool-summary ${isExpanded ? 'agent-tool-summary-full' : ''}`}>{summary}</span>}
          {message.streaming && <span className="agent-tool-badge">running</span>}
        </div>
        {isExpanded && (
          <>
            <ToolBody toolName={message.toolName} input={message.toolInput} cwd={cwd} />
            {message.toolResult && (() => {
              const { lines, remaining } = truncateLines(message.toolResult, 30);
              return <pre className="agent-tool-code agent-tool-result-block">{lines.join('\n')}{remaining > 0 ? `\n... +${remaining} more lines` : ''}</pre>;
            })()}
          </>
        )}
      </div>
    );
  }

  if (message.type === 'tool_result') {
    return null;
  }

  if (message.type === 'thinking') {
    const mode = resolveDisplayMode('thinking');
    if (mode === 'hidden') return null;
    return (
      <div className="agent-msg agent-msg-thinking">
        <div className="agent-thinking-header" onClick={() => setExpanded(!expanded)}>
          <span className={`agent-chevron ${expanded || mode === 'expanded' ? 'expanded' : ''}`}>&#9654;</span>
          <span className="agent-thinking-label">Thinking</span>
        </div>
        {(expanded || mode === 'expanded') && (
          <div className="agent-thinking-content">{message.content}</div>
        )}
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

  if (message.type === 'user') {
    return (
      <div className="agent-msg agent-msg-user">
        <div className="agent-msg-content">{message.content}</div>
      </div>
    );
  }

  // assistant
  const html = useMemo(() => renderMarkdown(message.content), [message.content]);
  const label = message.provider
    ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}:`
    : 'Assistant:';

  return (
    <div className="agent-msg agent-msg-assistant">
      <span className="agent-msg-label">{label}</span>
      <div className="agent-msg-content agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {message.streaming && <span className="agent-cursor" />}
    </div>
  );
}
