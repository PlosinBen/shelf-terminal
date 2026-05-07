import React, { useState, useMemo } from 'react';
import { useStore } from '../store';
import { renderMarkdown } from '../utils/markdown';
import { alignLineDiff, type DiffRow } from '../utils/line-diff';
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
  // Attachments captured at send-time so history renders the original
  // user turn faithfully. Images are data URIs (typically image/png base64).
  images?: string[];
  files?: Array<{ path: string; displayPath: string }>;
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
    case 'view':
      return stripCwd(String(input.file_path ?? input.path ?? ''), cwd);
    case 'Edit':
    case 'edit_file':
    case 'Write':
    case 'write_file':
      return stripCwd(String(input.file_path ?? input.path ?? ''), cwd);
    case 'str_replace_editor': {
      const path = stripCwd(String(input.file_path ?? input.path ?? ''), cwd);
      const cmd = String(input.command ?? '');
      return cmd ? `${path} (${cmd})` : path;
    }
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

function SideBySideDiff({ rows }: { rows: DiffRow[] }) {
  // Walk rows once to compute snippet-relative line numbers per side.
  // 'same'/'change' advance both; 'del' advances only old; 'add' advances only new.
  let oldLine = 0;
  let newLine = 0;
  const annotated = rows.map((row) => {
    const showOld = row.old !== null;
    const showNew = row.new !== null;
    if (showOld) oldLine++;
    if (showNew) newLine++;
    return { ...row, oldLine: showOld ? oldLine : null, newLine: showNew ? newLine : null };
  });
  return (
    <div className="agent-diff-sbs">
      <div className="agent-diff-sbs-panel agent-diff-sbs-panel-left">
        {annotated.map((row, i) => (
          <div key={i} className={`agent-diff-sbs-row agent-diff-sbs-${row.kind}`}>
            <span className="agent-diff-sbs-ln">{row.oldLine ?? ''}</span>
            <span className="agent-diff-sbs-cell">{row.old !== null ? row.old : ' '}</span>
          </div>
        ))}
      </div>
      <div className="agent-diff-sbs-panel agent-diff-sbs-panel-right">
        {annotated.map((row, i) => (
          <div key={i} className={`agent-diff-sbs-row agent-diff-sbs-${row.kind}`}>
            <span className="agent-diff-sbs-ln">{row.newLine ?? ''}</span>
            <span className="agent-diff-sbs-cell">{row.new !== null ? row.new : ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Inline "+ line" diff for create/write-style operations where everything
// is an addition. Truncates at 20 lines to keep tool cards compact.
function InlineAddDiff({ content }: { content: string }) {
  const { lines, remaining } = truncateLines(content, 20);
  return (
    <div className="agent-tool-diff-inline">
      {lines.map((line, i) => (
        <div key={i} className="agent-diff-row agent-diff-add">
          <span className="agent-diff-ln">{i + 1}</span>
          <span className="agent-diff-sign">+</span>
          <span className="agent-diff-text">{line}</span>
        </div>
      ))}
      {remaining > 0 && <div className="agent-tool-truncated">... +{remaining} more lines</div>}
    </div>
  );
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
    const rows = alignLineDiff(oldStr.split('\n'), newStr.split('\n'));
    return <SideBySideDiff rows={rows} />;
  }

  if (name === 'write' || name === 'write_file') {
    const content = String(input.content ?? '');
    return <InlineAddDiff content={content} />;
  }

  // Copilot's str_replace_editor multiplexes view/create/str_replace/insert/undo_edit
  // through a `command` field. Dispatch on the sub-command and reuse the same
  // visual renderers as Claude's Edit/Write/Read for consistency.
  if (name === 'str_replace_editor') {
    const cmd = String(input.command ?? '');
    if (cmd === 'str_replace') {
      const oldStr = String(input.old_str ?? input.old_string ?? '');
      const newStr = String(input.new_str ?? input.new_string ?? '');
      const rows = alignLineDiff(oldStr.split('\n'), newStr.split('\n'));
      return <SideBySideDiff rows={rows} />;
    }
    if (cmd === 'create') {
      const content = String(input.file_text ?? input.content ?? '');
      return <InlineAddDiff content={content} />;
    }
    if (cmd === 'insert') {
      const content = String(input.new_str ?? input.new_string ?? '');
      return <InlineAddDiff content={content} />;
    }
    // view / undo_edit / unknown sub-commands: nothing useful to render
    return null;
  }

  if (name === 'read' || name === 'read_file' || name === 'view'
      || name === 'list_directory' || name === 'glob') {
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
    const hasDetailBody = message.toolName === 'Edit' || message.toolName === 'Write' || message.toolName === 'edit_file' || message.toolName === 'write_file';
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
            {hasDetailBody && <ToolBody toolName={message.toolName} input={message.toolInput} cwd={cwd} />}
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
    const hasAttachments = (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0;
    return (
      <div className="agent-msg agent-msg-user">
        {message.content && <div className="agent-msg-content">{message.content}</div>}
        {hasAttachments && (
          <div className="agent-msg-attachments">
            {message.images?.map((url, i) => (
              <img key={`img-${i}`} src={url} className="agent-msg-image" alt={`attachment ${i + 1}`} />
            ))}
            {message.files?.map((f) => (
              <span key={f.path} className="agent-msg-file-chip" title={f.path}>{f.displayPath}</span>
            ))}
          </div>
        )}
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
