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
  listNotes, getNote, createNote, updateNote, deleteNote, deleteAllDone,
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
    await updateNote('p1', meta.id, { title: 'My Note', body: '# heading\n\nbody' });
    const note = await getNote('p1', meta.id);
    expect(note?.title).toBe('My Note');
    expect(note?.body).toBe('# heading\n\nbody');
    expect(note?.images).toEqual([]);
    expect(note?.isDone).toBe(false);
  });

  it('listNotes sorts by updated desc', async () => {
    const a = await createNote('p1');
    await new Promise((r) => setTimeout(r, 5));
    const b = await createNote('p1');
    await new Promise((r) => setTimeout(r, 5));
    await updateNote('p1', a.id, { body: 'touched a most recently' });

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
    const next = await updateNote('p1', m.id, { body: 'changed' });
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

describe('deleteAllDone', () => {
  it('removes only notes with isDone=true and returns the count', async () => {
    const a = await createNote('p1'); // stays active
    const b = await createNote('p1');
    const c = await createNote('p1');
    await updateNote('p1', b.id, { isDone: true });
    await updateNote('p1', c.id, { isDone: true });

    const removed = await deleteAllDone('p1');
    expect(removed).toBe(2);

    const remaining = await listNotes('p1');
    expect(remaining.map((n) => n.id)).toEqual([a.id]);
    expect(fs.existsSync(notePath('p1', b.id))).toBe(false);
    expect(fs.existsSync(notePath('p1', c.id))).toBe(false);
  });

  it('returns 0 when there are no done notes', async () => {
    await createNote('p1');
    const removed = await deleteAllDone('p1');
    expect(removed).toBe(0);
  });

  it('returns 0 when the project has no notes', async () => {
    const removed = await deleteAllDone('empty-proj');
    expect(removed).toBe(0);
  });

  it('does not touch other projects', async () => {
    const a = await createNote('p1');
    await updateNote('p1', a.id, { isDone: true });
    const b = await createNote('p2');
    await updateNote('p2', b.id, { isDone: true });

    const removed = await deleteAllDone('p1');
    expect(removed).toBe(1);
    expect(fs.existsSync(notePath('p2', b.id))).toBe(true);
  });
});

describe('saveImage + garbageCollectImages', () => {
  it('saveImage returns a bare filename (not images/ prefix)', async () => {
    const buf = new Uint8Array([1]).buffer;
    const filename = await saveImage('p1', buf, 'png');
    expect(filename).not.toContain('/');
    expect(filename).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(imagesDir('p1'), filename))).toBe(true);
  });

  it('keeps images referenced by any note (final state after GC)', async () => {
    const a = await createNote('p1');
    await createNote('p1');
    const buf = new Uint8Array([1]).buffer;
    const kept = await saveImage('p1', buf, 'png');
    const orphan = await saveImage('p1', buf, 'png');

    await updateNote('p1', a.id, { images: [kept] });

    expect(fs.existsSync(path.join(imagesDir('p1'), kept))).toBe(true);
    expect(fs.existsSync(path.join(imagesDir('p1'), orphan))).toBe(false);
  });

  it('updateNote auto-runs GC across all notes', async () => {
    const a = await createNote('p1');
    const b = await createNote('p1');
    const buf = new Uint8Array([1]).buffer;
    const filename = await saveImage('p1', buf, 'png');

    await updateNote('p1', a.id, { images: [filename] });
    await updateNote('p1', b.id, { body: 'unrelated edit' });

    expect(fs.existsSync(path.join(imagesDir('p1'), filename))).toBe(true);

    // Drop the only ref → next save should GC it.
    await updateNote('p1', a.id, { images: [] });
    expect(fs.existsSync(path.join(imagesDir('p1'), filename))).toBe(false);
  });

  it('deleteNote triggers GC of the now-orphaned image', async () => {
    const a = await createNote('p1');
    const buf = new Uint8Array([1]).buffer;
    const filename = await saveImage('p1', buf, 'png');
    await updateNote('p1', a.id, { images: [filename] });

    await deleteNote('p1', a.id);

    expect(fs.existsSync(path.join(imagesDir('p1'), filename))).toBe(false);
  });
});
