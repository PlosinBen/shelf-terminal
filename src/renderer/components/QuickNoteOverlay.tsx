import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore, closeQuickNote } from '../store';

/**
 * Floating overlay for jotting a note without opening the Notes sidebar.
 *
 * - Enter submits (Shift+Enter inserts a newline).
 * - Esc cancels — the draft is discarded.
 * - Closes silently on success; the new note is appended to the active
 *   project's notes via `quickCreateNote` (atomic create + body + auto-title).
 * - Disabled when there is no active project (the keybinding short-circuits
 *   before opening, but we double-check here as a safety net).
 */
export function QuickNoteOverlay() {
  const { quickNoteVisible, projects, activeProjectIndex } = useStore();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const project = projects[activeProjectIndex];

  useEffect(() => {
    if (quickNoteVisible) {
      setBody('');
      setSubmitting(false);
      // useEffect runs after DOM commit — textarea is mounted.
      textareaRef.current?.focus();
    }
  }, [quickNoteVisible]);

  const submit = useCallback(async () => {
    if (submitting) return;
    const trimmed = body.trim();
    if (!trimmed || !project) {
      closeQuickNote();
      return;
    }
    setSubmitting(true);
    try {
      await window.shelfApi.notes.quickCreate(project.config.id, body);
    } catch (err) {
      // Keep the overlay open so the user can retry / copy text out.
      // eslint-disable-next-line no-console
      console.error('quick-note: submit failed', err);
      setSubmitting(false);
      return;
    }
    closeQuickNote();
  }, [body, project, submitting]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuickNote();
      return;
    }
    // Enter submits; Shift+Enter inserts a newline (default behavior).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  if (!quickNoteVisible || !project) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) closeQuickNote();
  };

  return (
    <div className="quick-note-overlay" onClick={handleOverlayClick}>
      <div className="quick-note-panel">
        <div className="quick-note-header">
          <span className="quick-note-title">Quick Note</span>
          <span className="quick-note-project">{project.config.name}</span>
        </div>
        <textarea
          ref={textareaRef}
          className="quick-note-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Jot a note… Enter to save, Shift+Enter for newline, Esc to cancel"
          rows={6}
          disabled={submitting}
        />
        <div className="quick-note-hint">
          <span>Enter <span className="quick-note-kbd">⏎</span> save · Shift+Enter newline · Esc cancel</span>
        </div>
      </div>
    </div>
  );
}
