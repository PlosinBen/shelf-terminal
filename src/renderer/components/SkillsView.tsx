import React, { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { toggleRightSidebar } from '../store';
import { renderMarkdown } from '../utils/markdown';

interface SkillMeta {
  name: string;
  description?: string;
}

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 700;

/**
 * App-level Agent Skills manager (right sidebar). Master-detail like NotesView:
 * a list of skills, and a raw-markdown editor for the selected SKILL.md. The
 * skill identity is its folder name, derived from the frontmatter `name` on
 * save (rename moves the folder — collisions / invalid names are reported). See
 * agent feature `skills-workflows` §5.6.
 */
export function SkillsView() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const editorRef = useRef<SkillEditorHandle | null>(null);

  const refreshList = useCallback(async () => {
    setSkills(await window.shelfApi.skills.list());
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  const handleNew = useCallback(async () => {
    const meta = await window.shelfApi.skills.create();
    await refreshList();
    setActiveName(meta.name);
  }, [refreshList]);

  // Back saves first (like NoteEditor.close); a failed save (invalid name /
  // collision) keeps the user in the editor with the error shown.
  const handleBack = useCallback(async () => {
    if (editorRef.current) {
      const canLeave = await editorRef.current.flush();
      if (!canLeave) return;
    }
    setActiveName(null);
    await refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - e.clientX)));
    const onUp = () => setResizing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [resizing]);

  const inEditor = activeName !== null;

  return (
    <div className="right-panel skills-view" style={{ width }}>
      <div className="right-panel-resize-handle" onMouseDown={() => setResizing(true)} />
      <div className="right-panel-header">
        {inEditor ? (
          <button className="notes-back" onClick={handleBack}>‹ Back</button>
        ) : (
          <span className="right-panel-title">Skills</span>
        )}
        <span className="notes-header-actions">
          {!inEditor && (
            <button className="notes-new-btn" onClick={handleNew} title="New skill">+</button>
          )}
          <button className="notes-close" onClick={() => toggleRightSidebar('skills')}>×</button>
        </span>
      </div>

      {inEditor ? (
        <SkillEditor
          key={activeName!}
          ref={editorRef}
          name={activeName!}
          onRenamed={(newName) => setActiveName(newName)}
          onAfterSave={refreshList}
          onDeleted={handleBack}
        />
      ) : (
        <SkillsList skills={skills} onPick={setActiveName} />
      )}
    </div>
  );
}

function SkillsList({ skills, onPick }: { skills: SkillMeta[]; onPick: (name: string) => void }) {
  if (skills.length === 0) {
    return <div className="notes-empty">No skills yet. Click + to create one.</div>;
  }
  return (
    <div className="skills-list">
      {skills.map((s) => (
        <div key={s.name} className="skills-list-item" onClick={() => onPick(s.name)}>
          <div className="skills-list-name">{s.name}</div>
          {s.description && <div className="skills-list-desc">{s.description}</div>}
        </div>
      ))}
    </div>
  );
}

interface SkillEditorHandle {
  /** Save if dirty. Returns true if it's safe to leave (saved ok or unchanged),
   *  false if the save was rejected (invalid name / collision) and the user
   *  should stay. */
  flush: () => Promise<boolean>;
}

const SkillEditor = forwardRef<SkillEditorHandle, {
  name: string;
  onRenamed: (newName: string) => void;
  onAfterSave: () => void | Promise<void>;
  onDeleted: () => void;
}>(function SkillEditor({ name, onRenamed, onAfterSave, onDeleted }, ref) {
  const [content, setContent] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savedRef = useRef<string>('');
  const contentRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    window.shelfApi.skills.get(name).then((raw) => {
      if (cancelled) return;
      const c = raw ?? '';
      setContent(c);
      savedRef.current = c;
      contentRef.current = c;
    });
    return () => { cancelled = true; };
  }, [name]);

  const dirty = content !== null && content !== savedRef.current;

  const save = useCallback(async (): Promise<boolean> => {
    const c = contentRef.current;
    if (c === savedRef.current) return true; // unchanged
    setSaving(true);
    try {
      const res = await window.shelfApi.skills.update(name, c);
      if (!res.ok) {
        setError(res.error ?? 'Save failed');
        return false;
      }
      setError(null);
      savedRef.current = c;
      if (res.name && res.name !== name) onRenamed(res.name);
      await onAfterSave();
      return true;
    } finally {
      setSaving(false);
    }
  }, [name, onRenamed, onAfterSave]);

  useImperativeHandle(ref, () => ({ flush: save }), [save]);

  const previewHtml = useMemo(() => {
    if (content === null) return '';
    const body = content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return renderMarkdown(body, { breaks: true });
  }, [content]);

  const handleDelete = useCallback(async () => {
    const ok = await window.shelfApi.dialog.confirm('Delete skill', `Delete skill "${name}"? This cannot be undone.`, 'Delete');
    if (!ok) return;
    await window.shelfApi.skills.delete(name);
    onDeleted();
  }, [name, onDeleted]);

  if (content === null) return <div className="notes-empty">Loading…</div>;

  return (
    <>
      <div className="notes-mode-row">
        <button className={`notes-mode-btn ${mode === 'edit' ? 'active' : ''}`} onClick={() => setMode('edit')}>Edit</button>
        <button className={`notes-mode-btn ${mode === 'preview' ? 'active' : ''}`} onClick={() => setMode('preview')}>Preview</button>
        <span className="notes-mode-spacer" />
        <button
          className="notes-send-btn"
          onClick={() => void save()}
          disabled={!dirty || saving}
          title="Save (renames the folder if the frontmatter name changed)"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="notes-delete-btn" onClick={handleDelete} title="Delete skill">Delete</button>
      </div>
      {error && <div className="skills-error">{error}</div>}
      <div className="notes-body">
        {mode === 'edit' ? (
          <textarea
            className="notes-textarea"
            value={content}
            onChange={(e) => { setContent(e.target.value); contentRef.current = e.target.value; }}
            placeholder="SKILL.md — paste a skill, or fill in the template."
            spellCheck={false}
          />
        ) : (
          <div className="notes-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        )}
      </div>
    </>
  );
});
