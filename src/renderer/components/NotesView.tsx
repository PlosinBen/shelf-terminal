import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { marked } from 'marked';
import { useStore, toggleNotes } from '../store';

marked.setOptions({ breaks: true, gfm: true });

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

type Mode = 'preview' | 'edit';

export function NotesView() {
  const { projects, activeProjectIndex } = useStore();
  const project = projects[activeProjectIndex];
  const projectId = project?.config.id;

  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('preview');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>('');

  // Load on project change
  useEffect(() => {
    if (!projectId) {
      setContent('');
      setLoaded(true);
      lastSavedRef.current = '';
      return;
    }
    setLoaded(false);
    window.shelfApi.notes.read(projectId).then((text) => {
      setContent(text);
      lastSavedRef.current = text;
      setLoaded(true);
    });
  }, [projectId]);

  // Debounced auto-save while editing
  useEffect(() => {
    if (!projectId || !loaded) return;
    if (content === lastSavedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      window.shelfApi.notes.write(projectId, content);
      lastSavedRef.current = content;
    }, 800);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [content, projectId, loaded]);

  // Flush save when leaving edit mode
  const flushSave = useCallback(async () => {
    if (!projectId) return;
    if (content === lastSavedRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await window.shelfApi.notes.write(projectId, content);
    lastSavedRef.current = content;
  }, [content, projectId]);

  const switchMode = useCallback(async (next: Mode) => {
    if (next === mode) return;
    if (mode === 'edit') await flushSave();
    setMode(next);
  }, [mode, flushSave]);

  // Resize handle
  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)));
    };
    const handleUp = () => setResizing(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [resizing]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!projectId) return;
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
    // Restore caret after React updates
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
    return marked.parse(rewritten, { async: false }) as string;
  }, [content, projectId]);

  return (
    <div className="notes-view" style={{ width }}>
      <div className="notes-resize-handle" onMouseDown={() => setResizing(true)} />
      <div className="notes-header">
        <span className="notes-title">Notes</span>
        <span className="notes-header-actions">
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
          <button className="notes-close" onClick={() => { flushSave(); toggleNotes(); }}>×</button>
        </span>
      </div>
      <div className="notes-body">
        {!projectId ? (
          <div className="notes-empty">No project selected.</div>
        ) : !loaded ? (
          <div className="notes-empty">Loading…</div>
        ) : mode === 'edit' ? (
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
          <div className="notes-empty">No notes yet</div>
        ) : (
          <div className="notes-preview" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}

// Rewrite `images/<file>` paths inside markdown image syntax and HTML <img>
// to the shelf-image:// custom protocol so the renderer can load them.
function rewriteImagePaths(content: string, projectId: string): string {
  // ![alt](images/foo.png)
  let out = content.replace(
    /(!\[[^\]]*\]\()images\/([\w.-]+)(\))/g,
    (_m, p1, name, p3) => `${p1}shelf-image://${projectId}/${name}${p3}`,
  );
  // <img src="images/foo.png">
  out = out.replace(
    /(<img\s+[^>]*src=["'])images\/([\w.-]+)(["'])/g,
    (_m, p1, name, p3) => `${p1}shelf-image://${projectId}/${name}${p3}`,
  );
  return out;
}
