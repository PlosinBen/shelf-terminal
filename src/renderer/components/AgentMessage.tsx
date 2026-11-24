import type { AgentDiff } from '@shared/agent-diff';
import { EXECUTION_STATE as ES, EXECUTION_LABEL } from '@shared/agent-execution';
import React, { useState, useMemo, useContext, useRef, useLayoutEffect, useEffect } from 'react';
import type { AgentInputMessage } from '@shared/agent-input';
import { AGENT_EXIT_INTERRUPTED_LABEL } from '@shared/app-exit';
import { AgentDisplayContext } from './agent/AgentDisplayContext';
import { AgentInputSourceHeader } from './agent/AgentInputSourceHeader';
import { renderMarkdown } from '../utils/markdown';
import { alignLineDiff, type DiffRow } from '../utils/line-diff';
import type { AgentDisplayMode, AgentDisplayKey, AgentFile, FoldBase } from '@shared/types';
import { DEFAULT_AGENT_DISPLAY } from '@shared/types';

/**
 * Renderer-side message variant. Mirrors `AgentMessage` from `@shared/types`
 * (canonical provider-emitted shape) PLUS a `'user'` variant for messages the
 * user types into the input — providers never emit `user` (renderer-only).
 *
 * Discriminated union: each `type` carries exactly the fields it needs.
 * Common metadata (id / timestamp / provider) is intersected on top.
 *
 * Naming is pure rendering vocabulary — no provider semantics:
 *   reply / note / system / error / fold_* / user.
 *
 * See agent-ui#5 for design rationale.
 */
export type AgentMsg = {
  id: string;
  provider?: string;
  timestamp: number;
  /** Persistence-only snapshot marker; never signals runtime execution end. */
  exitInterrupted?: true;
  /**
   * Set when this message was emitted BY A SUBAGENT — value is the outer Agent
   * tool_use's id. The timeline nests it under that card instead of the main list.
   * Only reply + fold_* carry it. See subagent-display.
   */
  parentToolUseId?: string;
} & (
  | { type: 'reply'; content: string; streaming?: boolean }
  | { type: 'note'; content: string }
  | { type: 'system'; content: string }
  | { type: 'error'; content: string }
  | (FoldBase & { type: 'fold_text';     body?: { content: string; tone?: 'muted' }; streaming?: boolean })
  | (FoldBase & { type: 'fold_code'; details?: string; body?: { content: string } })
  | (FoldBase & { type: 'fold_markdown'; body?: { content: string } })
  | (FoldBase & { type: 'fold_diff';     body?: { diff: AgentDiff } })
  | { type: 'user'; content: string; images?: string[]; files?: AgentFile[]; inputMessage?: AgentInputMessage }
);

const OUTPUT_PREVIEW_LINES = 8;

function truncateLines(text: string, max: number): { lines: string[]; remaining: number } {
  const all = text.split('\n');
  if (all.length <= max) return { lines: all, remaining: 0 };
  return { lines: all.slice(0, max), remaining: all.length - max };
}

function SideBySideDiff({ rows, oldStart = 1, newStart = 1 }: { rows: DiffRow[]; oldStart?: number; newStart?: number }) {
  // Legacy snippets start at 1; hunks supply their original file positions.
  let oldLine = oldStart - 1;
  let newLine = newStart - 1;
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
            <span className="agent-diff-sbs-cell">{row.old !== null ? row.old : ' '}</span>
          </div>
        ))}
      </div>
      <div className="agent-diff-sbs-panel agent-diff-sbs-panel-right">
        {annotated.map((row, i) => (
          <div key={i} className={`agent-diff-sbs-row agent-diff-sbs-${row.kind}`}>
            <span className="agent-diff-sbs-ln">{row.newLine ?? ''}</span>
            <span className="agent-diff-sbs-cell">{row.new !== null ? row.new : ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface FoldHeaderProps {
  label: string;
  subtitle?: string;
  isExpanded: boolean;
  onToggle: () => void;
  keyboard?: boolean;
  summary?: boolean;
}

/** Shared header for all fold_* variants: chevron + label + subtitle.
 *  Subtitle truncates via CSS (white-space + text-overflow:ellipsis); the
 *  full string lives in the `title` attribute so users get the original on
 *  hover regardless of viewport width. */
function FoldHeader({ label, subtitle, isExpanded, onToggle, keyboard, summary }: FoldHeaderProps) {
  return (
    <div className="fold-header" onClick={summary ? undefined : onToggle}
      style={summary ? { cursor: 'default' } : undefined}
      {...(keyboard && !summary ? { role: 'button', tabIndex: 0, 'aria-expanded': isExpanded,
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); }
        },
      } : {})}>
      {summary
        ? <span className="agent-chevron-spacer" aria-hidden="true">&#9654;</span>
        : <span className={`agent-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>}
      <span className="fold-label">{label}</span>
      {subtitle && (
        <span className="fold-subtitle" title={subtitle}>{subtitle}</span>
      )}
    </div>
  );
}

function FoldCopyButton({ target, onCopy }: { target: 'details' | 'output'; onCopy: () => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const handleCopy = async () => {
    const success = await onCopy();
    clearTimeout(resetTimer.current);
    setCopied(success);
    if (success) resetTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  const label = `Copy ${target}`;
  return <button type="button" className="fold-copy-button" aria-label={label} title={copied ? 'Copied' : label}
    data-copied={copied} onClick={() => void handleCopy()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {copied ? <path d="m5 12 4 4L19 6" /> : <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </>}
    </svg>
  </button>;
}

/** Raw output controls are provider-independent. UI choices live for this mount;
 * remounting a failed card reveals its output again (agent-ui#5). */
function CodeFold({ message, settingMode, nested }: {
  message: Extract<AgentMsg, { type: 'fold_code' }>;
  settingMode: AgentDisplayMode;
  nested?: AgentMsg[];
}) {
  const execution = message.execution;
  const exitCode = execution?.exitCode;
  const exitedNonzero = execution?.state === ES.FAILED && exitCode !== undefined && exitCode !== 0;
  // Older Codex cards persisted a generic banner derived from the same exit code.
  const errorMessage = exitedNonzero && message.errorMessage === `Command failed with exit code ${exitCode}`
    ? undefined : message.errorMessage;
  const hasError = !!message.errorMessage || (message.execution !== undefined &&
    [ES.FAILED, ES.DECLINED, ES.INTERRUPTED, ES.UNKNOWN].some(state => state === message.execution!.state));
  const [expansion, setExpansion] = useState({ failureSeen: hasError, choice: null as boolean | null });
  // Adjust during render so the first failure cannot paint collapsed. Subsequent
  // snapshots (including duplicate failures) leave the user's choice intact.
  if (hasError && !expansion.failureSeen) {
    setExpansion({ failureSeen: true, choice: true });
  }
  // An explicit empty body is settled, unlike an absent (pending) body.
  const hasSeparateDetails = message.details !== undefined;
  const details = hasSeparateDetails ? message.details : message.subtitle;
  const summary = message.body?.content === '' && !message.details && !nested?.length;
  const isExpanded = !summary && (expansion.choice ?? (hasError || settingMode === 'expanded'));
  const [fullOutput, setFullOutput] = useState(false);
  const [wrapsPastPreview, setWrapsPastPreview] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const previewRef = useRef<HTMLSpanElement>(null);
  const output = message.body?.content ?? '';
  const preview = useMemo(() => truncateLines(output, OUTPUT_PREVIEW_LINES), [output]);
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el || preview.remaining) return;
    const measure = () => setWrapsPastPreview(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isExpanded, fullOutput, preview]);
  const copy = async (text: string, target: 'details' | 'output') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('');
      return true;
    } catch {
      console.warn('Could not copy fold content', { msgId: message.id, target });
      setCopyStatus(`Could not copy ${target}. Please select and copy the text manually.`);
      return false;
    }
  };
  return (
    <div className="agent-msg agent-msg-fold">
      <FoldHeader label={message.label} subtitle={isExpanded && !hasSeparateDetails ? undefined : message.subtitle} isExpanded={isExpanded} keyboard summary={summary}
        onToggle={() => setExpansion(current => ({ ...current, choice: !isExpanded }))} />
      {execution && execution.state !== ES.SUCCEEDED && <div className="fold-execution" data-state={execution.state}>
        {exitedNonzero ? `Exited with code ${exitCode}` :
          `${EXECUTION_LABEL[execution.state]}${exitCode === undefined ? '' : ` · exit ${exitCode}`}`}
      </div>}
      {errorMessage && <div className="fold-error-banner">{errorMessage}</div>}
      {isExpanded && <>
        {details && <div className="fold-body-container">
          <FoldCopyButton target="details" onCopy={() => copy(details, 'details')} />
          <pre className="fold-body fold-command-text" tabIndex={0} aria-label="Details">{details}</pre>
        </div>}
        {nested && nested.length > 0 && <div className="agent-subagent-nested">
          {nested.map(child => <AgentMessage key={child.id} message={child} />)}
        </div>}
        {output && <>
          {(preview.remaining > 0 || wrapsPastPreview || fullOutput) && <div className="fold-reading-controls">
            <button type="button" aria-expanded={fullOutput} onClick={() => setFullOutput(!fullOutput)}>
              {fullOutput ? 'Show preview' : preview.remaining ? `Show full output (${preview.lines.length + preview.remaining} lines)` : 'Show full output'}
            </button>
          </div>}
          <div className="fold-body-container">
            <FoldCopyButton target="output" onCopy={() => copy(output, 'output')} />
            <pre className="fold-body fold-body-code" data-preview={!fullOutput} tabIndex={fullOutput ? 0 : undefined} aria-label="Output">
              {fullOutput ? output : <span ref={previewRef} style={{ maxHeight: `${OUTPUT_PREVIEW_LINES}lh` }}>{preview.lines.join('\n')}</span>}
            </pre>
          </div>
        </>}
        {copyStatus && <div className="fold-copy-status" role="status">{copyStatus}</div>}
      </>}
    </div>
  );
}

interface Props {
  message: AgentMsg;
  cwd?: string;
  /** Subagent activity emitted under this message's tool_use (Agent/Task card).
   *  Rendered inside the card's expand area so a subagent has one nested home
   *  instead of flat rows in the main list. See subagent-display. */
  nested?: AgentMsg[];
}

export function AgentMessage({ message, cwd: _cwd, nested }: Props) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const agentDisplay = useContext(AgentDisplayContext);

  const resolveDisplayMode = (key: AgentDisplayKey): AgentDisplayMode => {
    return agentDisplay[key] ?? DEFAULT_AGENT_DISPLAY[key];
  };

  // Markdown for the `reply` variant — useMemo must run on every render.
  const replyContent = message.type === 'reply' ? message.content : '';
  const replyHtml = useMemo(() => renderMarkdown(replyContent), [replyContent]);

  // Markdown for the `fold_markdown` body — same constraint.
  const foldMdContent = message.type === 'fold_markdown' && message.body
    ? message.body.content
    : '';
  const foldMdHtml = useMemo(() => renderMarkdown(foldMdContent), [foldMdContent]);

  switch (message.type) {
    case 'reply':
      return (
        <div className="agent-msg agent-msg-reply">
          <div className="agent-msg-content agent-markdown" dangerouslySetInnerHTML={{ __html: replyHtml }} />
          {message.streaming === true && <span className="agent-cursor" />}
          {message.exitInterrupted && <div className="agent-msg-system">{AGENT_EXIT_INTERRUPTED_LABEL}</div>}
        </div>
      );

    case 'note':
      // Provider sends pure content; renderer owns the leading marker so the
      // visual contract for "note" lives in one place. Same layering as
      // `error` red coloring and `reply` markdown rendering.
      return (
        <div className="agent-msg agent-msg-note">
          <span className="agent-msg-note__marker">▸</span>
          <span className="agent-msg-note__content">{message.content}</span>
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

    case 'fold_text': {
      const hasError = !!message.errorMessage;
      const settingMode = resolveDisplayMode('fold_text');
      // Failed cards always expand; otherwise default per setting, user toggle wins.
      const isExpanded = hasError
        ? true
        : (userToggled !== null ? userToggled : settingMode === 'expanded');
      const streaming = message.streaming === true;
      return (
        <div className="agent-msg agent-msg-fold">
          <FoldHeader
            label={message.label}
            subtitle={message.subtitle}
            isExpanded={isExpanded}
            onToggle={() => setUserToggled(!isExpanded)}
          />
          {hasError && (
            <div className="fold-error-banner">{message.errorMessage}</div>
          )}
          {message.exitInterrupted && <div className="fold-error-banner">{AGENT_EXIT_INTERRUPTED_LABEL}</div>}
          {isExpanded && message.body && (
            <div
              className="fold-body fold-body-text"
              data-tone={message.body.tone ?? 'normal'}
            >
              {message.body.content}
              {streaming && <span className="agent-cursor" />}
            </div>
          )}
        </div>
      );
    }

    case 'fold_code': {
      return <CodeFold key={message.id} message={message} settingMode={resolveDisplayMode('fold_code')} nested={nested} />;
    }

    case 'fold_markdown': {
      const hasError = !!message.errorMessage;
      const settingMode = resolveDisplayMode('fold_markdown');
      const isExpanded = hasError
        ? true
        : (userToggled !== null ? userToggled : settingMode === 'expanded');
      return (
        <div className="agent-msg agent-msg-fold">
          <FoldHeader
            label={message.label}
            subtitle={message.subtitle}
            isExpanded={isExpanded}
            onToggle={() => setUserToggled(!isExpanded)}
          />
          {hasError && (
            <div className="fold-error-banner">{message.errorMessage}</div>
          )}
          {isExpanded && message.body && (
            <div
              className="fold-body fold-body-markdown agent-markdown"
              dangerouslySetInnerHTML={{ __html: foldMdHtml }}
            />
          )}
        </div>
      );
    }

    case 'fold_diff': {
      const hasError = !!message.errorMessage;
      const settingMode = resolveDisplayMode('fold_diff');
      const isExpanded = hasError
        ? true
        : (userToggled !== null ? userToggled : settingMode === 'expanded');
      return (
        <div className="agent-msg agent-msg-fold">
          <FoldHeader
            label={message.label}
            subtitle={message.subtitle}
            isExpanded={isExpanded}
            onToggle={() => setUserToggled(!isExpanded)}
          />
          {hasError && (
            <div className="fold-error-banner">{message.errorMessage}</div>
          )}
          {/* Skip diff body on failure — failed edits with stale old_string
              are transient intermediate states the agent itself retries; the
              red banner + header are enough to signal "this attempt failed". */}
          {isExpanded && !hasError && message.body?.diff && (() => {
            const diff = message.body.diff;
            return (
              <div className="fold-body fold-body-diff">
                {'hunks' in diff ? diff.hunks.map((hunk, index) => (
                  <div className="agent-diff-hunk" key={index}>
                    <div className="agent-diff-hunk-range">
                      {`@@ -${hunk.oldStart},${hunk.oldLines.length} +${hunk.newStart},${hunk.newLines.length} @@`}
                    </div>
                    <SideBySideDiff rows={alignLineDiff(hunk.oldLines, hunk.newLines)} oldStart={hunk.oldStart} newStart={hunk.newStart} />
                  </div>
                )) : <SideBySideDiff rows={alignLineDiff(diff.oldString.split('\n'), diff.newString.split('\n'))} />}
              </div>
            );
          })()}
        </div>
      );
    }

    case 'user': {
      const hasAttachments = (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0;
      return (
        <div className="agent-msg agent-msg-user">
          <AgentInputSourceHeader source={message.inputMessage?.source} />
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

    default: {
      // Exhaustiveness — new variants without a case here error at compile time.
      const _exhaustive: never = message;
      void _exhaustive;
      return null;
    }
  }
}
