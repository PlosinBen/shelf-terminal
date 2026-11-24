import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { toggleRightSidebar } from '../store';
import { renderMarkdown } from '../utils/markdown';
import { LockIcon, UnlockIcon, PowerIcon } from './icons';
import { RightPanel, RIGHT_PANEL_WIDTH } from './RightPanel';
import { SKILL_EDITOR_MAIN_FILE } from '@shared/skill-editor';
import { LINK_OPEN } from '@shared/link-open-intent';
import { useSkillCommandDraft, resetSkillCommandDraft, loadSkillCommandDraft, editSkillCommandDraft, peekSkillCommandDraft, isSkillCommandDirty, markSkillCommandSaved, markSkillEditorUncertain } from '../skillCommandDraftStore';

interface SkillMeta {
  name: string;
  description?: string;
  locked?: boolean;
  disabled?: boolean;
  commandAlias?: string;
  commandError?: string;
}

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
  const editorRef = useRef<SkillEditorHandle | null>(null);

  const refreshList = useCallback(async () => {
    setSkills(await window.shelfApi.skills.list());
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  // Keep the list live when a skill changes outside this view — e.g. the agent
  // creates/updates one through the app-skill bridge. Refetch only refreshes the
  // list; an open editor keeps its own (possibly dirty) content untouched.
  useEffect(() => window.shelfApi.skills.onChanged(() => { void refreshList(); }), [refreshList]);

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

  const inEditor = activeName !== null;

  return (
    <RightPanel
      className="skills-view"
      aria-label="Skills"
      defaultWidth={RIGHT_PANEL_WIDTH.defaults.skills}
      header={(
        <>
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
        </>
      )}
    >
      {inEditor ? (
        <SkillEditor
          key={activeName!}
          ref={editorRef}
          name={activeName!}
          locked={skills.find((s) => s.name === activeName)?.locked ?? false}
          disabled={skills.find((s) => s.name === activeName)?.disabled ?? false}
          description={skills.find((s) => s.name === activeName)?.description ?? ''}
          onRenamed={(newName) => setActiveName(newName)}
          onAfterSave={refreshList}
          onDeleted={() => { setActiveName(null); void refreshList(); }}
        />
      ) : (
        <SkillsList skills={skills} onPick={setActiveName} />
      )}
    </RightPanel>
  );
}

function SkillsList({ skills, onPick }: { skills: SkillMeta[]; onPick: (name: string) => void }) {
  if (skills.length === 0) {
    return <div className="notes-empty">No skills yet. Click + to create one.</div>;
  }
  return (
    <div className="skills-list">
      {skills.map((s) => (
        <div
          key={s.name}
          className={`skills-list-item ${s.disabled ? 'disabled' : ''}`}
          onClick={() => onPick(s.name)}
        >
          <div className="skills-list-main">
            <div className="skills-list-name">{s.name}</div>
            {s.commandAlias && <div className="skills-list-command">/{s.commandAlias}</div>}
            {s.commandError && <div className="skills-error">{s.commandError}</div>}
            {s.description && <div className="skills-list-desc">{s.description}</div>}
          </div>
          <button
            className={`skills-enable-toggle ${s.disabled ? 'disabled' : ''}`}
            title={s.disabled ? 'Disabled — not loaded by agents. Click to enable' : 'Enabled — click to disable (removes it from agent context)'}
            onClick={(e) => { e.stopPropagation(); void window.shelfApi.skills.setDisabled(s.name, !s.disabled); }}
          >
            <PowerIcon size={14} />
          </button>
          <button
            className={`skills-lock-toggle ${s.locked ? 'locked' : ''}`}
            title={s.locked ? 'Locked against agent edits — click to unlock' : 'Lock against agent edits'}
            onClick={(e) => { e.stopPropagation(); void window.shelfApi.skills.setLocked(s.name, !s.locked); }}
          >
            {s.locked ? <LockIcon size={14} /> : <UnlockIcon size={14} />}
          </button>
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

const SKILL_MD = SKILL_EDITOR_MAIN_FILE;
const isMarkdownFile = (file: string) => file === SKILL_MD || file.toLowerCase().endsWith('.md');

const SkillEditor = forwardRef<SkillEditorHandle, {
  name: string;
  locked: boolean;
  disabled: boolean;
  description: string;
  onRenamed: (newName: string) => void;
  onAfterSave: () => void | Promise<void>;
  onDeleted: () => void;
}>(function SkillEditor({ name, locked, disabled, description, onRenamed, onAfterSave, onDeleted }, ref) {
  // Which file the editor body is currently showing. SKILL.md is the privileged
  // default (its own save path: frontmatter validation + rename); aux files
  // (scripts/reference docs) use the generic file IPC. See skills#8.
  const [activeFile, setActiveFile] = useState<string>(SKILL_MD);
  const [files, setFiles] = useState<string[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState('');
  const savedRef = useRef<string>('');
  const contentRef = useRef<string>('');
  const activeFileRef = useRef<string>(SKILL_MD);
  const actualNameRef = useRef(name);
  const saveInFlight = useRef(false);
  const command = useSkillCommandDraft();
  activeFileRef.current = activeFile;

  const refreshFiles = useCallback(async () => {
    setFiles(await window.shelfApi.skills.listFiles(actualNameRef.current));
  }, [name]);

  useEffect(() => { void refreshFiles(); }, [refreshFiles]);
  // An agent (or external edit) can add/remove aux files while the panel is open.
  useEffect(() => window.shelfApi.skills.onChanged(() => { void refreshFiles(); }), [refreshFiles]);

  useEffect(() => {
    let cancelled = false;
    resetSkillCommandDraft();
    window.shelfApi.skills.readEditor(name).then(result => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error); return; }
      loadSkillCommandDraft(result.value.command, name, description);
    }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [name]);

  // Load the active file's content whenever the file (or skill) changes.
  useEffect(() => {
    let cancelled = false;
    const load = activeFile === SKILL_MD
      ? window.shelfApi.skills.get(actualNameRef.current)
      : window.shelfApi.skills.readFile(actualNameRef.current, activeFile);
    setContent(null);
    load.then((raw) => {
      if (cancelled) return;
      const c = raw ?? '';
      setContent(c);
      savedRef.current = c;
      contentRef.current = c;
      if (!isMarkdownFile(activeFile)) setMode('edit'); // no markdown preview for scripts
    });
    return () => { cancelled = true; };
  }, [name, activeFile]);

  const dirty = content !== null && (content !== savedRef.current || isSkillCommandDirty());
  const canPreview = isMarkdownFile(activeFile);

  // One coordinator saves the active file plus command draft and reports partial persistence.
  const save = useCallback(async (): Promise<boolean> => {
    const c = contentRef.current;
    if (content === null || saveInFlight.current || !command.loaded || command.uncertain) return false;
    if (c === savedRef.current && !isSkillCommandDirty()) return true;
    const commandDraft = peekSkillCommandDraft();
    saveInFlight.current = true;
    let acknowledged = false;
    setSaving(true);
    try {
      const res = await window.shelfApi.skills.saveEditor({ name: actualNameRef.current, activeFile: activeFileRef.current, content: c, commandDraft });
      acknowledged = true;
      actualNameRef.current = res.name;
      if (res.saved.content) savedRef.current = c;
      if (res.saved.command) markSkillCommandSaved(commandDraft);
      if (res.uncertain) markSkillEditorUncertain();
      if (!res.ok) { setError(res.error ?? 'Save failed'); return false; }
      setError(null);
      if (res.name !== name) onRenamed(res.name);
      await onAfterSave();
      return true;
    } catch (error) {
      // Lost IPC acknowledgement leaves persistence unknown. Do not auto-resend.
      if (!acknowledged) markSkillEditorUncertain();
      setError(String(error));
      return false;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [name, onRenamed, onAfterSave, command.loaded, command.uncertain, content]);

  useImperativeHandle(ref, () => ({ flush: save }), [save]);

  // Switch files — flush (save) the current one first; a rejected save keeps you put.
  const switchFile = useCallback(async (target: string) => {
    if (target === activeFileRef.current) return;
    if (!(await save())) return;
    setError(null);
    setActiveFile(target);
  }, [save]);

  const submitNewFile = useCallback(async () => {
    const p = newPath.trim();
    if (!p) return;
    if (!(await save())) return; // don't lose unsaved edits on the current file
    const res = await window.shelfApi.skills.writeFile(actualNameRef.current, p, '');
    if (!res.ok) { setError(res.error ?? 'Could not create file'); return; }
    setError(null);
    setAdding(false);
    setNewPath('');
    await refreshFiles();
    setActiveFile(p);
  }, [name, newPath, save, refreshFiles]);

  const deleteFile = useCallback(async (file: string) => {
    const ok = await window.shelfApi.dialog.confirm('Delete file', `Delete "${file}" from skill "${name}"?`, 'Delete');
    if (!ok) return;
    const res = await window.shelfApi.skills.deleteFile(actualNameRef.current, file);
    if (!res.ok) { setError(res.error ?? 'Delete failed'); return; }
    await refreshFiles();
    if (activeFileRef.current === file) setActiveFile(SKILL_MD);
  }, [name, refreshFiles]);

  const previewHtml = useMemo(() => {
    if (content === null || !canPreview) return '';
    // SKILL.md hides its frontmatter in preview; an aux .md renders whole.
    const body = activeFile === SKILL_MD
      ? content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      : content;
    return renderMarkdown(body, { breaks: true });
  }, [content, canPreview, activeFile]);

  // Lock only fences the AGENT out (enforced main-side) — the manager UI here
  // can always toggle it. The list refresh that reflects the new icon arrives
  // via the SKILLS_CHANGED subscription in the parent.
  const toggleLock = useCallback(async () => {
    await window.shelfApi.skills.setLocked(actualNameRef.current, !locked);
  }, [name, locked]);

  // Enable/disable is a MOUNT toggle (not an edit gate): disabling removes the
  // skill from the projected tree so agents stop loading it. The list refresh
  // reflecting the new state arrives via the SKILLS_CHANGED subscription.
  const toggleDisabled = useCallback(async () => {
    await window.shelfApi.skills.setDisabled(actualNameRef.current, !disabled);
  }, [name, disabled]);

  const handleDelete = useCallback(async () => {
    const ok = await window.shelfApi.dialog.confirm('Delete skill', `Delete skill "${name}"? This cannot be undone.`, 'Delete');
    if (!ok) return;
    await window.shelfApi.skills.delete(actualNameRef.current);
    onDeleted();
  }, [name, onDeleted]);

  const showFilesBox = files.length > 0 || adding;

  return (
    <>
      <div className="notes-mode-row">
        <button className={`notes-mode-btn ${mode === 'edit' ? 'active' : ''}`} onClick={() => setMode('edit')}>Edit</button>
        {canPreview && (
          <button className={`notes-mode-btn ${mode === 'preview' ? 'active' : ''}`} onClick={() => setMode('preview')}>Preview</button>
        )}
        <button
          className="notes-mode-btn skills-addfile-btn"
          onClick={() => { setAdding(true); setNewPath(''); }}
          title="Add a file (script / reference) to this skill"
        >+ File</button>
        <span className="notes-mode-spacer" />
        <button
          className="notes-send-btn"
          onClick={() => void save()}
          disabled={!dirty || saving || !command.loaded || command.uncertain}
          title={activeFile === SKILL_MD ? 'Save (renames the folder if the frontmatter name changed)' : `Save ${activeFile}`}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className={`notes-mode-btn skills-enable-btn ${disabled ? 'disabled' : ''}`}
          onClick={() => void toggleDisabled()}
          title={disabled ? 'Disabled — not loaded by agents. Click to enable' : 'Enabled — click to disable (removes it from agent context)'}
        >
          <PowerIcon size={13} />
          {disabled ? 'Disabled' : 'Enabled'}
        </button>
        <button
          className="notes-mode-btn skills-lock-btn"
          onClick={() => void toggleLock()}
          title={locked ? 'Locked against agent edits — click to unlock' : 'Lock against agent edits'}
        >
          {locked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
          {locked ? 'Locked' : 'Lock'}
        </button>
        <button className="notes-delete-btn" onClick={handleDelete} title="Delete this skill">Delete</button>
      </div>

      <div className="skills-command-settings">
        <label className="skills-command-toggle">
          <input type="checkbox" checked={command.enabled} disabled={!command.loaded || saving || command.uncertain}
            onChange={event => editSkillCommandDraft({ enabled: event.target.checked })} />
          Add to slash command menu
        </label>
        {command.enabled && <div className="skills-command-fields">
          <label>Command<input aria-label="Command" value={command.alias} placeholder="dev-flow" spellCheck={false}
            disabled={saving || command.uncertain || !!command.metadataError}
            onChange={event => editSkillCommandDraft({ alias: event.target.value })} /></label>
          <label>Description<input aria-label="Command description" value={command.description} maxLength={256}
            disabled={saving || command.uncertain || !!command.metadataError}
            onChange={event => editSkillCommandDraft({ description: event.target.value })} /></label>
        </div>}
        {command.metadataError && <div className="skills-error">{command.metadataError}. Uncheck and save to remove invalid command settings.</div>}
        {command.uncertain && <div className="skills-error">Save state is uncertain. Reopen Skills to read the persisted state before retrying.</div>}
      </div>

      {showFilesBox && (
        <div className="skills-files">
          <div
            className={`skills-file-item ${activeFile === SKILL_MD ? 'active' : ''}`}
            onClick={() => void switchFile(SKILL_MD)}
          >
            <span className="skills-file-name">{SKILL_MD}</span>
          </div>
          {files.map((f) => (
            <div
              key={f}
              className={`skills-file-item ${activeFile === f ? 'active' : ''}`}
              onClick={() => void switchFile(f)}
            >
              <span className="skills-file-name">{f}</span>
              <button
                className="skills-file-del"
                title={`Delete ${f}`}
                onClick={(e) => { e.stopPropagation(); void deleteFile(f); }}
              >×</button>
            </div>
          ))}
          {adding && (
            <div className="skills-file-add">
              <input
                className="skills-file-add-input"
                autoFocus
                value={newPath}
                placeholder="scripts/build.sh"
                spellCheck={false}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitNewFile();
                  else if (e.key === 'Escape') { setAdding(false); setNewPath(''); }
                }}
              />
              <button className="skills-file-add-ok" onClick={() => void submitNewFile()} disabled={!newPath.trim()}>Add</button>
              <button className="skills-file-add-cancel" onClick={() => { setAdding(false); setNewPath(''); }}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {error && <div className="skills-error">{error}</div>}
      <div className="notes-body">
        {content === null ? (
          <div className="notes-empty">Loading…</div>
        ) : mode === 'edit' || !canPreview ? (
          <textarea
            className="notes-textarea"
            value={content}
            onChange={(e) => { setContent(e.target.value); contentRef.current = e.target.value; }}
            placeholder={activeFile === SKILL_MD ? 'SKILL.md — paste a skill, or fill in the template.' : activeFile}
            spellCheck={false}
            disabled={saving || command.uncertain}
          />
        ) : (
          <div className="notes-preview" {...{ [LINK_OPEN.skillAttribute]: actualNameRef.current, [LINK_OPEN.skillFileAttribute]: activeFile }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
        )}
      </div>
    </>
  );
});
