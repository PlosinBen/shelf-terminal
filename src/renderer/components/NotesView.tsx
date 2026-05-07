import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useStore, toggleNotes } from '../store';
import { renderMarkdown } from '../utils/markdown';

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

type Mode = 'preview' | 'edit';
type Filter = 'active' | 'done' | 'all';

interface NoteMeta {
  id: string;
  title: string;
  isDone: boolean;
  created: string;
  updated: string;
}

interface Note extends NoteMeta {
  content: string;
}

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
          <button className="notes-close" onClick={() => toggleNotes()}>×</button>
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
        />
      )}
    </div>
  );
}

// ── List ───────────────────────────────────────────────────────

function NotesList({
  notes, counts, filter, onFilterChange, onPick,
}: {
  notes: NoteMeta[];
  counts: { active: number; done: number; all: number };
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  onPick: (id: string) => void;
}) {
  return (
    <>
      <div className="notes-filter-row">
        <FilterTab label="Active" count={counts.active} active={filter === 'active'} onClick={() => onFilterChange('active')} />
        <FilterTab label="Done" count={counts.done} active={filter === 'done'} onClick={() => onFilterChange('done')} />
        <FilterTab label="All" count={counts.all} active={filter === 'all'} onClick={() => onFilterChange('all')} />
      </div>
      <div className="notes-body">
        {notes.length === 0 ? (
          <div className="notes-empty">No notes yet</div>
        ) : (
          <ul className="notes-list">
            {notes.map((n) => (
              <li
                key={n.id}
                className={`notes-list-item ${n.isDone ? 'notes-list-item-done' : ''}`}
                onClick={() => onPick(n.id)}
              >
                <span className="notes-list-title">{n.title || '(untitled)'}</span>
                <span className="notes-list-time">{relativeTime(n.updated)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function FilterTab({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`notes-filter-tab ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {label} <span className="notes-filter-count">{count}</span>
    </button>
  );
}

// ── Editor ─────────────────────────────────────────────────────

interface NoteEditorHandle {
  /** Apply title fallback / delete-if-empty / flush pending save.
   *  Resolves once the IPC write (or delete) completes. */
  close: () => Promise<void>;
}

interface NoteEditorProps {
  projectId: string;
  noteId: string;
  onAfterSave: () => void;
  onDelete: () => void;
  /** Called when the editor wants to navigate back to the list
   *  (e.g. user toggled Done). Parent runs `close()` then unmounts us. */
  onRequestBack: () => void;
}

const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor({
  projectId, noteId, onAfterSave, onDelete, onRequestBack,
}, ref) {
  const [note, setNote] = useState<Note | null>(null);
  const [mode, setMode] = useState<Mode>('edit');
  const [title, setTitle] = useState('');
  const [titleOverridden, setTitleOverridden] = useState(false);
  const [content, setContent] = useState('');
  const [isDone, setIsDone] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<{ title: string; content: string; isDone: boolean }>({ title: '', content: '', isDone: false });

  useEffect(() => {
    let cancelled = false;
    window.shelfApi.notes.get(projectId, noteId).then((n) => {
      if (cancelled || !n) return;
      setNote(n);
      setTitle(n.title);
      setContent(n.content);
      setIsDone(n.isDone);
      // If title was already set, treat as overridden so auto-derive doesn't fight.
      setTitleOverridden(n.title.length > 0);
      lastSavedRef.current = { title: n.title, content: n.content, isDone: n.isDone };
      // Focus textarea on open (new note flow defaults to edit mode).
      requestAnimationFrame(() => textareaRef.current?.focus());
    });
    return () => { cancelled = true; };
  }, [projectId, noteId]);

  // Auto-derive title from first H1 until the user overrides.
  useEffect(() => {
    if (titleOverridden) return;
    const m = content.match(/^#\s+(.+?)\s*$/m);
    const derived = m ? m[1].trim() : '';
    setTitle(derived);
  }, [content, titleOverridden]);

  // Debounced auto-save
  useEffect(() => {
    if (!note) return;
    const last = lastSavedRef.current;
    if (last.title === title && last.content === content && last.isDone === isDone) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      await window.shelfApi.notes.update(projectId, noteId, { title, content, isDone });
      lastSavedRef.current = { title, content, isDone };
      onAfterSave();
    }, 600);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [title, content, isDone, note, projectId, noteId, onAfterSave]);

  const flushSave = useCallback(async () => {
    const last = lastSavedRef.current;
    if (last.title === title && last.content === content && last.isDone === isDone) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await window.shelfApi.notes.update(projectId, noteId, { title, content, isDone });
    lastSavedRef.current = { title, content, isDone };
    onAfterSave();
  }, [title, content, isDone, projectId, noteId, onAfterSave]);

  const switchMode = useCallback(async (next: Mode) => {
    if (next === mode) return;
    if (mode === 'edit') await flushSave();
    setMode(next);
  }, [mode, flushSave]);

  // Refs mirror state so close() — invoked imperatively from the parent —
  // reads the latest values without depending on closure capture timing.
  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const isDoneRef = useRef(isDone);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { isDoneRef.current = isDone; }, [isDone]);

  const close = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const t = titleRef.current.trim();
    const c = contentRef.current;
    const cTrim = c.trim();
    // Both empty → drop the note instead of persisting an empty record.
    // Covers the "+ New, then Back without typing" path.
    if (!t && !cTrim) {
      try { await window.shelfApi.notes.delete(projectId, noteId); } catch { /* ignore */ }
      return;
    }
    // Title empty → derive from first non-blank line of body. Strip leading
    // markdown heading marks and cap at 80 chars so list rows stay tidy.
    let finalTitle = t;
    if (!finalTitle) {
      const firstLine = c.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
      finalTitle = firstLine.replace(/^#+\s+/, '').slice(0, 80);
    }
    const last = lastSavedRef.current;
    const done = isDoneRef.current;
    if (last.title === finalTitle && last.content === c && last.isDone === done) return;
    await window.shelfApi.notes.update(projectId, noteId, { title: finalTitle, content: c, isDone: done });
    lastSavedRef.current = { title: finalTitle, content: c, isDone: done };
  }, [projectId, noteId]);

  useImperativeHandle(ref, () => ({ close }), [close]);

  // Done toggle: when checked, immediately request close — parent runs
  // close() (which saves with isDone=true via isDoneRef) and pops back to
  // the list. Updating the ref synchronously avoids a stale-state save.
  const handleToggleDone = useCallback((next: boolean) => {
    setIsDone(next);
    isDoneRef.current = next;
    if (next) onRequestBack();
  }, [onRequestBack]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const buffer = await file.arrayBuffer();
        const ext = item.type.split('/')[1] || 'png';
        const ref = await window.shelfApi.notes.saveImage(projectId, buffer, ext);
        insertAtCursor(`![](${ref})`);
        return;
      }
    }
  }, [projectId]);

  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setContent((prev) => prev + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    setContent((prev) => prev.slice(0, start) + text + prev.slice(end));
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + text.length;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
      }
    });
  }, []);

  const html = useMemo(() => {
    if (!projectId) return '';
    const rewritten = rewriteImagePaths(content, projectId);
    return renderMarkdown(rewritten, { breaks: true });
  }, [content, projectId]);

  if (!note) {
    return <div className="notes-empty">Loading…</div>;
  }

  return (
    <>
      <div className="notes-meta-row">
        <input
          className="notes-title-input"
          placeholder="Title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setTitleOverridden(true); }}
        />
        <label className="notes-done-toggle">
          <input
            type="checkbox"
            checked={isDone}
            onChange={(e) => handleToggleDone(e.target.checked)}
          />
          Done
        </label>
      </div>
      <div className="notes-mode-row">
        <button
          className={`notes-mode-btn ${mode === 'preview' ? 'active' : ''}`}
          onClick={() => switchMode('preview')}
        >
          Preview
        </button>
        <button
          className={`notes-mode-btn ${mode === 'edit' ? 'active' : ''}`}
          onClick={() => switchMode('edit')}
        >
          Edit
        </button>
        <span className="notes-mode-spacer" />
        <button className="notes-delete-btn" onClick={onDelete} title="Delete note">Delete</button>
      </div>
      <div className="notes-body">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            className="notes-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onPaste={handlePaste}
            placeholder="Write notes here. Paste images directly. Markdown supported."
            spellCheck={false}
          />
        ) : content.trim() === '' ? (
          <div className="notes-empty">(empty)</div>
        ) : (
          <div className="notes-preview" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </>
  );
});

// Rewrite `images/<file>` paths so the renderer can load them via shelf-image://
function rewriteImagePaths(content: string, projectId: string): string {
  let out = content.replace(
    /(!\[[^\]]*\]\()images\/([\w.-]+)(\))/g,
    (_m, p1, name, p3) => `${p1}shelf-image://${projectId}/${name}${p3}`,
  );
  out = out.replace(
    /(<img\s+[^>]*src=["'])images\/([\w.-]+)(["'])/g,
    (_m, p1, name, p3) => `${p1}shelf-image://${projectId}/${name}${p3}`,
  );
  return out;
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
