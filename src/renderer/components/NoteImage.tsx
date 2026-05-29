import React, { useEffect, useState } from 'react';

/**
 * Reusable thumbnail row item for note image attachments.
 *
 * Loads bytes via `notes.readImage` IPC, exposes them through a Blob URL, and
 * owns the URL's lifecycle so it's revoked on unmount or `filename` change.
 * Hover reveals an ✕ in the top-right that calls `onRemove` — the parent
 * is responsible for actually dropping the filename from its images array.
 *
 * Shared by NotesView (sidebar panel) and QuickNoteOverlay (paste-capture
 * popup). Both surfaces want the exact same "image renders below the
 * textarea, ✕ on hover" behavior, so the component lives at the components/
 * top level rather than inside either consumer.
 */
export function NoteImage({
  projectId,
  filename,
  onRemove,
}: {
  projectId: string;
  filename: string;
  onRemove: () => void;
}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let cancelled = false;
    let url = '';
    window.shelfApi.notes.readImage(projectId, filename).then((buf) => {
      if (cancelled || !buf) return;
      url = URL.createObjectURL(new Blob([buf]));
      setSrc(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, filename]);
  return (
    <div className="notes-image-wrap">
      {src && <img src={src} className="notes-image" alt="" />}
      <button
        type="button"
        className="notes-image-remove"
        onClick={onRemove}
        title="Remove image"
        aria-label="Remove image"
      >
        ×
      </button>
    </div>
  );
}
