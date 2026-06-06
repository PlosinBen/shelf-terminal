import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore, toggleRightSidebar } from '../store';
import { NotesList } from './NotesList';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import type { NoteMeta, Filter } from './notes-types';

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

export function NotesView() {
  const { projects, activeProjectIndex } = useStore();
  const project = projects[activeProjectIndex];
  const projectId = project?.config.id;

  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [filter, setFilter] = useState<Filter>('active');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  // Imperative handle on the active editor so the Back button (and the Done
  // auto-close path) can run editor-side close logic — apply title fallback,
  // delete-if-empty, flush any pending save — before the editor unmounts.
  const editorRef = useRef<NoteEditorHandle | null>(null);

  // Load list when project changes
  useEffect(() => {
    if (!projectId) {
      setNotes([]);
      setActiveId(null);
      return;
    }
    window.shelfApi.notes.list(projectId).then(setNotes);
    setActiveId(null);
  }, [projectId]);

  // Refresh list helper
  const refreshList = useCallback(async () => {
    if (!projectId) return;
    const list = await window.shelfApi.notes.list(projectId);
    setNotes(list);
  }, [projectId]);

  const handleNew = useCallback(async () => {
    if (!projectId) return;
    const meta = await window.shelfApi.notes.create(projectId);
    await refreshList();
    setActiveId(meta.id);
  }, [projectId, refreshList]);

  const handleBack = useCallback(async () => {
    // Run editor close before tearing it down so the IPC write completes
    // before refreshList — list otherwise shows stale title or a deleted note.
    if (editorRef.current) {
      try { await editorRef.current.close(); } catch { /* swallow — UX shouldn't block on save */ }
    }
    setActiveId(null);
    await refreshList();
  }, [refreshList]);

  const handleDelete = useCallback(async (id: string) => {
    if (!projectId) return;
    await window.shelfApi.notes.delete(projectId, id);
    if (activeId === id) setActiveId(null);
    await refreshList();
  }, [projectId, activeId, refreshList]);

  // Bulk delete every done note in this project. Confirm dialog spells out
  // the count so the user knows the scope before agreeing — see
  // .agent/DECISIONS.md note delete UX.
  const handleDeleteAllDone = useCallback(async () => {
    if (!projectId) return;
    const doneCount = notes.filter((n) => n.isDone).length;
    if (doneCount === 0) return;
    const ok = await window.shelfApi.dialog.confirm(
      'Delete done notes',
      `Delete ${doneCount} done note${doneCount === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete',
    );
    if (!ok) return;
    await window.shelfApi.notes.deleteAllDone(projectId);
    await refreshList();
  }, [projectId, notes, refreshList]);

  // Resize handle
  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      const w = window.innerWidth - e.clientX;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)));
    };
    const handleUp = () => setResizing(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [resizing]);

  const counts = useMemo(() => ({
    active: notes.filter((n) => !n.isDone).length,
    done: notes.filter((n) => n.isDone).length,
    all: notes.length,
  }), [notes]);

  const filtered = useMemo(() => {
    if (filter === 'active') return notes.filter((n) => !n.isDone);
    if (filter === 'done') return notes.filter((n) => n.isDone);
    return notes;
  }, [notes, filter]);

  const inActive = activeId !== null;

  return (
    <div className="right-panel notes-view" style={{ width }}>
      <div className="right-panel-resize-handle notes-resize-handle" onMouseDown={() => setResizing(true)} />
      <div className="right-panel-header notes-header">
        {inActive ? (
          <button className="notes-back" onClick={handleBack}>‹ Back</button>
        ) : (
          <span className="right-panel-title notes-title">Notes</span>
        )}
        <span className="notes-header-actions">
          {!inActive && (
            <button className="notes-new-btn" onClick={handleNew} title="New note">+</button>
          )}
          <button className="notes-close" onClick={() => toggleRightSidebar('notes')}>×</button>
        </span>
      </div>

      {!projectId ? (
        <div className="notes-empty">No project selected.</div>
      ) : inActive ? (
        <NoteEditor
          key={activeId}
          ref={editorRef}
          projectId={projectId}
          noteId={activeId!}
          onAfterSave={refreshList}
          onDelete={() => handleDelete(activeId!)}
          onRequestBack={handleBack}
        />
      ) : (
        <NotesList
          notes={filtered}
          counts={counts}
          filter={filter}
          onFilterChange={setFilter}
          onPick={setActiveId}
          onDeleteAllDone={handleDeleteAllDone}
        />
      )}
    </div>
  );
}
