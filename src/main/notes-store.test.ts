import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}));

const {
  listNotes, getNote, createNote, updateNote, deleteNote,
  saveImage, garbageCollectImages, parseFrontmatter,
  notesDir, notePath, imagesDir,
} = await import('./notes-store');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-notes-store-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('parseFrontmatter', () => {
  it('returns empty meta when no frontmatter', () => {
    const r = parseFrontmatter('# heading\n\nbody');
    expect(r.meta).toEqual({});
    expect(r.body).toBe('# heading\n\nbody');
  });

  it('parses scalar fields', () => {
    const raw = '---\ntitle: Hello\nis_done: true\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\nbody here';
    const r = parseFrontmatter(raw);
    expect(r.meta).toEqual({
      title: 'Hello',
      isDone: true,
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
    });
    expect(r.body).toBe('body here');
  });

  it('unquotes quoted values with escaped chars', () => {
    const raw = '---\ntitle: "Hello \\"world\\""\nis_done: false\ncreated: x\nupdated: y\n---\n';
    const r = parseFrontmatter(raw);
    expect(r.meta.title).toBe('Hello "world"');
  });

  it('treats unterminated frontmatter as plain content', () => {
    const raw = '---\ntitle: Hello\nstill in header';
    const r = parseFrontmatter(raw);
    expect(r.meta).toEqual({});
    expect(r.body).toBe(raw);
  });
});

describe('createNote / getNote / listNotes', () => {
  it('createNote returns a meta with empty title and isDone false', async () => {
    const meta = await createNote('p1');
    expect(meta.title).toBe('');
    expect(meta.isDone).toBe(false);
    expect(meta.created).toBe(meta.updated);
    expect(fs.existsSync(notePath('p1', meta.id))).toBe(true);
  });

  it('getNote round-trips frontmatter + body', async () => {
    const meta = await createNote('p1');
    await updateNote('p1', meta.id, { title: 'My Note', content: '# heading\n\nbody' });
    const note = await getNote('p1', meta.id);
    expect(note?.title).toBe('My Note');
    expect(note?.content).toBe('# heading\n\nbody');
    expect(note?.isDone).toBe(false);
  });

  it('listNotes sorts by updated desc', async () => {
    const a = await createNote('p1');
    await new Promise((r) => setTimeout(r, 5));
    const b = await createNote('p1');
    await new Promise((r) => setTimeout(r, 5));
    await updateNote('p1', a.id, { content: 'touched a most recently' });

    const list = await listNotes('p1');
    expect(list.map((n) => n.id)).toEqual([a.id, b.id]);
  });

  it('listNotes returns empty when notes dir missing', async () => {
    expect(await listNotes('p-empty')).toEqual([]);
  });

  it('listNotes ignores non-md files', async () => {
    const dir = notesDir('p1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignore');

    const meta = await createNote('p1');
    const list = await listNotes('p1');
    expect(list.map((n) => n.id)).toEqual([meta.id]);
  });
});

describe('updateNote', () => {
  it('updates title and isDone independently', async () => {
    const m = await createNote('p1');
    await updateNote('p1', m.id, { title: 'T1' });
    let n = await getNote('p1', m.id);
    expect(n?.title).toBe('T1');
    expect(n?.isDone).toBe(false);

    await updateNote('p1', m.id, { isDone: true });
    n = await getNote('p1', m.id);
    expect(n?.title).toBe('T1');
    expect(n?.isDone).toBe(true);
  });

  it('returns null for unknown id', async () => {
    expect(await updateNote('p1', 'does-not-exist', { title: 'x' })).toBeNull();
  });

  it('refuses unsafe ids (path traversal)', async () => {
    expect(await updateNote('p1', '../escape', { title: 'x' })).toBeNull();
  });

  it('bumps updated timestamp', async () => {
    const m = await createNote('p1');
    await new Promise((r) => setTimeout(r, 5));
    const next = await updateNote('p1', m.id, { content: 'changed' });
    expect(next!.updated > m.updated).toBe(true);
    expect(next!.created).toBe(m.created);
  });
});

describe('deleteNote', () => {
  it('removes the file', async () => {
    const m = await createNote('p1');
    await deleteNote('p1', m.id);
    expect(fs.existsSync(notePath('p1', m.id))).toBe(false);
  });

  it('is a no-op on unknown id', async () => {
    await expect(deleteNote('p1', 'nope')).resolves.toBeUndefined();
  });
});

describe('saveImage + garbageCollectImages', () => {
  it('keeps images referenced by any note (final state after GC)', async () => {
    const a = await createNote('p1');
    await createNote('p1');
    const buf = new Uint8Array([1]).buffer;
    const refKept = await saveImage('p1', buf, 'png');
    const refOrphan = await saveImage('p1', buf, 'png');

    await updateNote('p1', a.id, { content: `keep ![](${refKept})` });

    const keptName = refKept.slice('images/'.length);
    const orphanName = refOrphan.slice('images/'.length);
    expect(fs.existsSync(path.join(imagesDir('p1'), keptName))).toBe(true);
    expect(fs.existsSync(path.join(imagesDir('p1'), orphanName))).toBe(false);
  });

  it('updateNote auto-runs GC across all notes', async () => {
    const a = await createNote('p1');
    const b = await createNote('p1');
    const buf = new Uint8Array([1]).buffer;
    const ref = await saveImage('p1', buf, 'png');

    await updateNote('p1', a.id, { content: `![](${ref})` });
    await updateNote('p1', b.id, { content: 'unrelated edit' });

    const name = ref.slice('images/'.length);
    expect(fs.existsSync(path.join(imagesDir('p1'), name))).toBe(true);

    // Drop the only ref → next save should GC it.
    await updateNote('p1', a.id, { content: 'no image' });
    expect(fs.existsSync(path.join(imagesDir('p1'), name))).toBe(false);
  });

  it('deleteNote triggers GC of the now-orphaned image', async () => {
    const a = await createNote('p1');
    const buf = new Uint8Array([1]).buffer;
    const ref = await saveImage('p1', buf, 'png');
    await updateNote('p1', a.id, { content: `![](${ref})` });

    await deleteNote('p1', a.id);

    const name = ref.slice('images/'.length);
    expect(fs.existsSync(path.join(imagesDir('p1'), name))).toBe(false);
  });
});
