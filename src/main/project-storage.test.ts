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

const { projectDir, ensureProjectDir, removeProjectStorage, projectsRoot } = await import('./project-storage');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-project-storage-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('projectDir / projectsRoot', () => {
  it('returns <userData>/projects/<id>', () => {
    expect(projectsRoot()).toBe(path.join(tmpDir, 'projects'));
    expect(projectDir('abc')).toBe(path.join(tmpDir, 'projects', 'abc'));
  });
});

describe('ensureProjectDir', () => {
  it('creates the directory if missing', () => {
    const dir = ensureProjectDir('p1');
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toBe(path.join(tmpDir, 'projects', 'p1'));
  });

  it('is idempotent when directory already exists', () => {
    ensureProjectDir('p1');
    ensureProjectDir('p1');
    expect(fs.existsSync(path.join(tmpDir, 'projects', 'p1'))).toBe(true);
  });
});

describe('removeProjectStorage', () => {
  it('removes the project directory and its contents', async () => {
    const dir = ensureProjectDir('p1');
    fs.writeFileSync(path.join(dir, 'pm-note.md'), 'hello');
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images', 'a.png'), 'binary');

    await removeProjectStorage('p1');

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('is a no-op when directory does not exist', async () => {
    await expect(removeProjectStorage('does-not-exist')).resolves.toBeUndefined();
  });

  it('does not affect sibling projects', async () => {
    const a = ensureProjectDir('a');
    const b = ensureProjectDir('b');
    fs.writeFileSync(path.join(a, 'note.md'), 'a');
    fs.writeFileSync(path.join(b, 'note.md'), 'b');

    await removeProjectStorage('a');

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.readFileSync(path.join(b, 'note.md'), 'utf-8')).toBe('b');
  });
});
