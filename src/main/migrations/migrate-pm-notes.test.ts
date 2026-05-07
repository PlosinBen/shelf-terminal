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

const { migratePmNotes } = await import('./migrate-pm-notes');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-migrate-pm-notes-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function oldNotePath(id: string): string {
  return path.join(tmpDir, 'pm-notes', `${id}.md`);
}

function newNotePath(id: string): string {
  return path.join(tmpDir, 'projects', id, 'pm-note.md');
}

function writeOld(id: string, content: string) {
  const dir = path.join(tmpDir, 'pm-notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(oldNotePath(id), content);
}

describe('migratePmNotes', () => {
  it('is a no-op when old directory does not exist', async () => {
    await expect(migratePmNotes()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'projects'))).toBe(false);
  });

  it('moves a single pm-note into projects/<id>/pm-note.md', async () => {
    writeOld('abc', 'hello world');

    await migratePmNotes();

    expect(fs.existsSync(oldNotePath('abc'))).toBe(false);
    expect(fs.readFileSync(newNotePath('abc'), 'utf-8')).toBe('hello world');
  });

  it('moves multiple notes', async () => {
    writeOld('a', 'A');
    writeOld('b', 'B');
    writeOld('c', 'C');

    await migratePmNotes();

    expect(fs.readFileSync(newNotePath('a'), 'utf-8')).toBe('A');
    expect(fs.readFileSync(newNotePath('b'), 'utf-8')).toBe('B');
    expect(fs.readFileSync(newNotePath('c'), 'utf-8')).toBe('C');
  });

  it('removes the old pm-notes directory when it becomes empty', async () => {
    writeOld('a', 'A');

    await migratePmNotes();

    expect(fs.existsSync(path.join(tmpDir, 'pm-notes'))).toBe(false);
  });

  it('skips files that have already been migrated and unlinks the stale source', async () => {
    writeOld('a', 'old content');
    fs.mkdirSync(path.join(tmpDir, 'projects', 'a'), { recursive: true });
    fs.writeFileSync(newNotePath('a'), 'new content');

    await migratePmNotes();

    expect(fs.existsSync(oldNotePath('a'))).toBe(false);
    expect(fs.readFileSync(newNotePath('a'), 'utf-8')).toBe('new content');
  });

  it('ignores non-md files in pm-notes/', async () => {
    fs.mkdirSync(path.join(tmpDir, 'pm-notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pm-notes', 'README.txt'), 'ignore me');
    writeOld('a', 'A');

    await migratePmNotes();

    expect(fs.readFileSync(newNotePath('a'), 'utf-8')).toBe('A');
    // README.txt remains in old dir; old dir is therefore not removed
    expect(fs.existsSync(path.join(tmpDir, 'pm-notes', 'README.txt'))).toBe(true);
  });

  it('is idempotent when run twice', async () => {
    writeOld('a', 'A');

    await migratePmNotes();
    await migratePmNotes();

    expect(fs.readFileSync(newNotePath('a'), 'utf-8')).toBe('A');
  });
});
