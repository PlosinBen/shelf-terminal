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

const { readNote, writeNote, saveImage, garbageCollectImages, imagesDir, notePath } = await import('./notes-store');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-notes-store-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('readNote', () => {
  it('returns empty string when note does not exist', async () => {
    expect(await readNote('p1')).toBe('');
  });

  it('returns content when note exists', async () => {
    await writeNote('p1', '# Hello');
    expect(await readNote('p1')).toBe('# Hello');
  });
});

describe('writeNote', () => {
  it('creates the project dir and writes the note', async () => {
    await writeNote('p1', 'content');
    expect(fs.existsSync(notePath('p1'))).toBe(true);
    expect(fs.readFileSync(notePath('p1'), 'utf-8')).toBe('content');
  });
});

describe('saveImage', () => {
  it('writes the buffer under images/ and returns relative ref', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const ref = await saveImage('p1', buf, 'png');

    expect(ref).toMatch(/^images\/[\w.-]+\.png$/);
    const filename = ref.slice('images/'.length);
    expect(fs.existsSync(path.join(imagesDir('p1'), filename))).toBe(true);
  });

  it('falls back to .png for unknown extensions', async () => {
    const buf = new Uint8Array([0]).buffer;
    const ref = await saveImage('p1', buf, 'svg+xml; charset=utf-8');
    expect(ref).toMatch(/\.png$/);
  });

  it('accepts jpeg/gif/webp', async () => {
    const buf = new Uint8Array([0]).buffer;
    expect(await saveImage('p1', buf, 'jpeg')).toMatch(/\.jpeg$/);
    expect(await saveImage('p1', buf, 'gif')).toMatch(/\.gif$/);
    expect(await saveImage('p1', buf, 'webp')).toMatch(/\.webp$/);
  });
});

describe('garbageCollectImages', () => {
  it('removes images that are not referenced in the note', async () => {
    const buf = new Uint8Array([1]).buffer;
    const refKept = await saveImage('p1', buf, 'png');
    const refOrphan = await saveImage('p1', buf, 'png');

    const removed = await garbageCollectImages('p1', `text ![](${refKept}) more`);
    expect(removed).toBe(1);

    const keptName = refKept.slice('images/'.length);
    const orphanName = refOrphan.slice('images/'.length);
    expect(fs.existsSync(path.join(imagesDir('p1'), keptName))).toBe(true);
    expect(fs.existsSync(path.join(imagesDir('p1'), orphanName))).toBe(false);
  });

  it('keeps images referenced via raw HTML <img>', async () => {
    const buf = new Uint8Array([1]).buffer;
    const ref = await saveImage('p1', buf, 'png');
    const name = ref.slice('images/'.length);

    const removed = await garbageCollectImages('p1', `<img src="${ref}" />`);
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(imagesDir('p1'), name))).toBe(true);
  });

  it('returns 0 when images dir does not exist', async () => {
    expect(await garbageCollectImages('p-empty', 'no images')).toBe(0);
  });

  it('removes all images when note has no references', async () => {
    const buf = new Uint8Array([1]).buffer;
    await saveImage('p1', buf, 'png');
    await saveImage('p1', buf, 'png');

    const removed = await garbageCollectImages('p1', 'plain text');
    expect(removed).toBe(2);
  });
});

describe('writeNote auto-GC', () => {
  it('deletes orphaned images when note is saved', async () => {
    const buf = new Uint8Array([1]).buffer;
    const refA = await saveImage('p1', buf, 'png');
    const refB = await saveImage('p1', buf, 'png');

    await writeNote('p1', `keep ![](${refA})`);

    const aName = refA.slice('images/'.length);
    const bName = refB.slice('images/'.length);
    expect(fs.existsSync(path.join(imagesDir('p1'), aName))).toBe(true);
    expect(fs.existsSync(path.join(imagesDir('p1'), bName))).toBe(false);
  });
});
