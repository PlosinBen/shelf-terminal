import React, { useState, useMemo } from 'react';
import { useStore } from '../store';
import { renderMarkdown } from '../utils/markdown';
import { alignLineDiff, type DiffRow } from '../utils/line-diff';
import type { AgentDisplayMode, AgentDisplayKey, AgentFile, FoldBase } from '@shared/types';

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
 * See `.agent/features/agent-message-type-refactor.md` for design rationale.
 */
export type AgentMsg = {
  id: string;
  provider?: string;
  timestamp: number;
} & (
  | { type: 'reply'; content: string; streaming?: boolean }
  | { type: 'note'; content: string }
  | { type: 'system'; content: string }
  | { type: 'error'; content: string }
  | (FoldBase & { type: 'fold_text';     body?: { content: string; tone?: 'muted' }; streaming?: boolean })
  | (FoldBase & { type: 'fold_code';     body?: { content: string } })
  | (FoldBase & { type: 'fold_markdown'; body?: { content: string } })
  | (FoldBase & { type: 'fold_diff';     body?: { diff: { oldString: string; newString: string } } })
  | { type: 'user'; content: string; images?: string[]; files?: AgentFile[] }
);

function truncateLines(text: string, max: number): { lines: string[]; remaining: number } {
  const all = text.split('\n');
  if (all.length <= max) return { lines: all, remaining: 0 };
  return { lines: all.slice(0, max), remaining: all.length - max };
}

function SideBySideDiff({ rows }: { rows: DiffRow[] }) {
  // Walk rows once to compute snippet-relative line numbers per side.
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

/** Default display mode per fold key. fold_text / fold_code default collapsed
 *  (low signal-to-noise output); fold_markdown / fold_diff default expanded
 *  (structured / high-information content). */
const DEFAULT_FOLD_MODE: Record<AgentDisplayKey, AgentDisplayMode> = {
  fold_text: 'collapsed',
  fold_code: 'collapsed',
  fold_markdown: 'expanded',
  fold_diff: 'expanded',
};

interface FoldHeaderProps {
  label: string;
  subtitle?: string;
  isExpanded: boolean;
  onToggle: () => void;
}

/** Shared header for all fold_* variants: chevron + label + subtitle.
 *  Subtitle truncates via CSS (white-space + text-overflow:ellipsis); the
 *  full string lives in the `title` attribute so users get the original on
 *  hover regardless of viewport width. */
function FoldHeader({ label, subtitle, isExpanded, onToggle }: FoldHeaderProps) {
  return (
    <div className="fold-header" onClick={onToggle}>
      <span className={`agent-chevron ${isExpanded ? 'expanded' : ''}`}>&#9654;</span>
      <span className="fold-label">{label}</span>
      {subtitle && (
        <span className="fold-subtitle" title={subtitle}>{subtitle}</span>
      )}
    </div>
  );
}

interface Props {
  message: AgentMsg;
  cwd?: string;
}

export function AgentMessage({ message, cwd: _cwd }: Props) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const { settings } = useStore();

  const resolveDisplayMode = (key: AgentDisplayKey): AgentDisplayMode => {
    return settings.agentDisplay?.[key] ?? DEFAULT_FOLD_MODE[key];
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
    case 'reply': {
      const label = message.provider
        ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}:`
        : 'Assistant:';
      return (
        <div className="agent-msg agent-msg-reply">
          <span className="agent-msg-label">{label}</span>
          <div className="agent-msg-content agent-markdown" dangerouslySetInnerHTML={{ __html: replyHtml }} />
          {message.streaming === true && <span className="agent-cursor" />}
        </div>
      );
    }

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
      const hasError = !!message.errorMessage;
      const settingMode = resolveDisplayMode('fold_code');
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
          {isExpanded && message.body && (() => {
            const { lines, remaining } = truncateLines(message.body.content, 30);
            return (
              <pre className="fold-body fold-body-code">
                {lines.join('\n')}
                {remaining > 0 ? `\n... +${remaining} more lines` : ''}
              </pre>
            );
          })()}
        </div>
      );
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
            const rows = alignLineDiff(
              message.body.diff.oldString.split('\n'),
              message.body.diff.newString.split('\n'),
            );
            return (
              <div className="fold-body fold-body-diff">
                <SideBySideDiff rows={rows} />
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
