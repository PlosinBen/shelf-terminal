import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore, closeQuickNote } from '../store';
import { parseDataTransfer } from '../utils/parse-data-transfer';
import { NoteImage } from './NoteImage';

/**
 * Floating overlay for jotting a note without opening the Notes sidebar.
 *
 * - Enter submits (Shift+Enter inserts a newline).
 * - Esc cancels — the draft is discarded.
 * - Closes silently on success; the new note is appended to the active
 *   project's notes via `quickCreateNote` (atomic create + body + auto-title).
 * - Disabled when there is no active project (the keybinding short-circuits
 *   before opening, but we double-check here as a safety net).
 *
 * Image paste mirrors NotesView: pasted images are uploaded via
 * `notes.saveImage`, the textarea stays pure text, and thumbnails render
 * below the textarea. On submit, `quickCreate` receives `body` and `images`
 * separately — they live in the note's frontmatter `images` array, not
 * inline in the body, so the same note can be opened and edited later in
 * NotesView without any format surprises. Submit is allowed whenever
 * `body` OR `images` is non-empty.
 */
export function QuickNoteOverlay() {
  const { quickNoteVisible, projects, activeProjectIndex } = useStore();
  const [body, setBody] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const project = projects[activeProjectIndex];

  useEffect(() => {
    if (quickNoteVisible) {
      setBody('');
      setImages([]);
      setSubmitting(false);
      // useEffect runs after DOM commit — textarea is mounted.
      textareaRef.current?.focus();
    }
  }, [quickNoteVisible]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!project) return;
    const items = parseDataTransfer(e.clipboardData);
    const pastedImages = items.filter((i) => i.isImage);
    if (pastedImages.length === 0) return; // pure text → textarea handles
    e.preventDefault();
    for (const item of pastedImages) {
      if (!item.isImage) continue; // narrows text variant away
      try {
        const buffer = await item.file.arrayBuffer();
        const filename = await window.shelfApi.notes.saveImage(
          project.config.id,
          buffer,
          item.ext,
        );
        setImages((prev) => [...prev, filename]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('quick-note: image paste failed', err);
      }
    }
  }, [project]);

  const removeImage = useCallback((filename: string) => {
    setImages((prev) => prev.filter((f) => f !== filename));
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (!project) {
      closeQuickNote();
      return;
    }
    const trimmed = body.trim();
    // Allow submission when either text or at least one image is present.
    // Pure-image notes are legitimate quick captures (a screenshot with no
    // commentary still has value).
    if (!trimmed && images.length === 0) {
      closeQuickNote();
      return;
    }
    setSubmitting(true);
    try {
      await window.shelfApi.notes.quickCreate(project.config.id, body, images);
    } catch (err) {
      // Keep the overlay open so the user can retry / copy text out.
      // eslint-disable-next-line no-console
      console.error('quick-note: submit failed', err);
      setSubmitting(false);
      return;
    }
    closeQuickNote();
  }, [body, images, project, submitting]);

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
          onPaste={handlePaste}
          placeholder="Jot a note… Enter to save, Shift+Enter for newline, Esc to cancel. Paste images to attach."
          rows={6}
          disabled={submitting}
        />
        {images.length > 0 && (
          <div className="quick-note-images">
            {images.map((filename) => (
              <NoteImage
                key={filename}
                projectId={project.config.id}
                filename={filename}
                onRemove={() => removeImage(filename)}
              />
            ))}
          </div>
        )}
        <div className="quick-note-hint">
          <span>Enter <span className="quick-note-kbd">⏎</span> save · Shift+Enter newline · Esc cancel</span>
        </div>
      </div>
    </div>
  );
}
