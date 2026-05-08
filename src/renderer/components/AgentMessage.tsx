import React, { useState, useMemo } from 'react';
import { useStore } from '../store';
import { renderMarkdown } from '../utils/markdown';
import { alignLineDiff, type DiffRow } from '../utils/line-diff';
import type { AgentDisplayMode } from '@shared/types';

/**
 * Renderer-side message variant. Mirrors `AgentMessage` from `@shared/types`
 * (canonical provider-emitted shape) and adds a `'user'` variant for messages
 * the user types into the input — those don't come from any provider.
 *
 * Discriminated union: each `type` carries exactly the fields it needs.
 * Common metadata (id / timestamp / provider) is intersected on top.
 *
 * See `.agent/features/AGENT_VIEW_MSG_TYPE.md` for design rationale.
 */
export type AgentMsg = {
  id: string;
  provider?: string;
  timestamp: number;
} & (
  | { type: 'text'; content: string; streaming?: boolean }
  | { type: 'thinking'; content: string; streaming?: boolean }
  | { type: 'intent'; content: string }
  | { type: 'system'; content: string }
  | { type: 'error'; content: string }
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      result?: { content: string; isError?: boolean };
    }
  | {
      type: 'file_edit';
      toolUseId: string;
      filePath: string;
      diff?: { oldString: string; newString: string };
      content?: string;
      result?: { success: boolean; error?: string };
    }
  | {
      type: 'user';
      content: string;
      images?: string[];
      files?: Array<{ path: string; displayPath: string }>;
    }
);


function stripCwd(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;
  if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1);
  return filePath;
}

function getToolSummary(toolName: string, input: Record<string, unknown>, cwd?: string): string {
  // File-mutation tools (Edit/Write/edit_file/write_file/apply_patch) are
  // translated by providers into the dedicated `file_edit` canonical type, so
  // they never reach this generic tool_use renderer.
  switch (toolName) {
    case 'Bash':
    case 'bash':
      return String(input.command ?? '');
    case 'Read':
    case 'read_file':
    case 'view':
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

function ToolBody({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  const name = toolName.toLowerCase();
  if (name === 'bash') {
    return <pre className="agent-tool-code">{String(input.command ?? '')}</pre>;
  }
  // Read-style tools have nothing useful to show in the body — header summary is enough.
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

  // useMemo must run on every render path → compute markdown HTML for any
  // content-bearing variant up front (cheap when content is short / unchanged).
  const markdownContent = message.type === 'text' ? message.content : '';
  const markdownHtml = useMemo(() => renderMarkdown(markdownContent), [markdownContent]);

  switch (message.type) {
    case 'tool_use': {
      const toolMode = resolveDisplayMode(message.toolName) ?? resolveDisplayMode('other');
      if (toolMode === 'hidden') return null;
      const isExpanded = expanded || toolMode === 'expanded';
      const summary = getToolSummary(message.toolName, message.toolInput, cwd);
      const result = message.result;
      const isError = result?.isError === true;
      return (
        <div className="agent-msg agent-msg-tool">
          <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
            <span className={`agent-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>
            <span className="agent-tool-name">{message.toolName}</span>
            {summary && <span className={`agent-tool-summary ${isExpanded ? 'agent-tool-summary-full' : ''}`}>{summary}</span>}
            {!result && <span className="agent-tool-badge">running</span>}
          </div>
          {isExpanded && (
            <>
              <ToolBody toolName={message.toolName} input={message.toolInput} />
              {result && (() => {
                const { lines, remaining } = truncateLines(result.content, 30);
                const className = isError
                  ? 'agent-tool-code agent-tool-result-block agent-tool-result-error'
                  : 'agent-tool-code agent-tool-result-block';
                return <pre className={className}>{lines.join('\n')}{remaining > 0 ? `\n... +${remaining} more lines` : ''}</pre>;
              })()}
            </>
          )}
        </div>
      );
    }

    case 'file_edit': {
      // Reuse the user's per-tool display preference: treat all file edits as
      // 'Edit' for the collapsed/expanded/hidden setting (regardless of which
      // SDK tool produced them — Claude `Edit`/`Write`, Copilot `apply_patch`).
      const editMode = resolveDisplayMode('Edit') ?? resolveDisplayMode('other');
      if (editMode === 'hidden') return null;
      const isExpanded = expanded || editMode === 'expanded';
      const result = message.result;
      const success = result?.success === true;
      const failed = result?.success === false;
      return (
        <div className="agent-msg agent-msg-tool agent-msg-file-edit">
          <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
            <span className={`agent-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>
            <span className="agent-tool-name">
              {message.diff ? 'Edit' : 'Write'}
              {success && <span className="agent-tool-result-indicator agent-tool-result-success" title="Success">{' '}✓</span>}
              {failed && <span className="agent-tool-result-indicator agent-tool-result-failure" title="Failed">{' '}✗</span>}
            </span>
            <span className={`agent-tool-summary ${isExpanded ? 'agent-tool-summary-full' : ''}`}>
              {stripCwd(message.filePath, cwd)}
            </span>
            {!result && <span className="agent-tool-badge">running</span>}
          </div>
          {isExpanded && (
            <>
              {message.diff && (() => {
                const rows = alignLineDiff(message.diff.oldString.split('\n'), message.diff.newString.split('\n'));
                return <SideBySideDiff rows={rows} />;
              })()}
              {message.content !== undefined && <InlineAddDiff content={message.content} />}
              {failed && result.error && (
                <pre className="agent-tool-code agent-tool-result-block agent-tool-result-error">{result.error}</pre>
              )}
            </>
          )}
        </div>
      );
    }

    case 'thinking': {
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

    case 'intent':
      return (
        <div className="agent-msg agent-msg-intent">
          <span className="agent-intent-marker">▸</span>
          <span className="agent-intent-content">{message.content}</span>
        </div>
      );

    case 'system':
      return (
        <div className="agent-msg agent-msg-system">
          <span>{message.content}</span>
        </div>
      );

    case 'error':
      return (
        <div className="agent-msg agent-msg-error">
          <span className="agent-error-label">Error:</span>
          <span>{message.content}</span>
        </div>
      );

    case 'user': {
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

    case 'text': {
      const label = message.provider
        ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}:`
        : 'Assistant:';
      return (
        <div className="agent-msg agent-msg-assistant">
          <span className="agent-msg-label">{label}</span>
          <div className="agent-msg-content agent-markdown" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          {message.streaming && <span className="agent-cursor" />}
        </div>
      );
    }

    default: {
      // Exhaustiveness check — adding a new variant to AgentMsg without a
      // matching case here is a TS compile error.
      const _exhaustive: never = message;
      void _exhaustive;
      return null;
    }
  }
}
