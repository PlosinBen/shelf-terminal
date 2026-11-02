import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as realOs from 'node:os';

// shared.ts resolves the canonical skills root under os.homedir(); mock the bare
// 'os' specifier it imports so the projection runs against a tmp $HOME. A hoisted
// holder keeps the mutable home value safe to reference inside the hoisted factory.
const h = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => h.home };
});

import { projectAppSkills, readUploadedImageAttachments } from './shared';

// Exercises the shared L2 skill-projection mechanic the agent-server owns (the
// provider only declares the target). Uses a real tmp $HOME so the symlink +
// idempotency + atomic-replace paths run for real.
describe('projectAppSkills', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    h.home = '';
  });

  /** Point the mocked os.homedir() at a tmp dir and seed the canonical skill tree. */
  function setupHome(appId: string, skills: string[]): string {
    tmp = fs.mkdtempSync(path.join(realOs.tmpdir(), 'shelf-skills-'));
    h.home = tmp;
    const canonicalSkills = path.join(tmp, '.shelf', 'apps', appId, 'skills', 'skills');
    for (const s of skills) fs.mkdirSync(path.join(canonicalSkills, s), { recursive: true });
    return canonicalSkills;
  }

  it('symlinks the target to the canonical skill folders', () => {
    const canonicalSkills = setupHome('app-1', ['s1']);
    const target = path.join(tmp!, 'copilot-home', 'skills');

    expect(projectAppSkills('app-1', target)).toBeNull();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(canonicalSkills);
    // The skill folder resolves through the link.
    expect(fs.existsSync(path.join(target, 's1'))).toBe(true);
  });

  it('is idempotent — a second call preserves the link (no churn)', () => {
    setupHome('app-1', ['s1']);
    const target = path.join(tmp!, 'copilot-home', 'skills');

    expect(projectAppSkills('app-1', target)).toBeNull();
    const before = fs.readlinkSync(target);
    expect(projectAppSkills('app-1', target)).toBeNull();
    expect(fs.readlinkSync(target)).toBe(before);
  });

  it('atomically replaces a stale real directory sitting at the target', () => {
    setupHome('app-1', ['s1']);
    const target = path.join(tmp!, 'copilot-home', 'skills');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'stale.txt'), 'x');

    expect(projectAppSkills('app-1', target)).toBeNull();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(target, 'stale.txt'))).toBe(false);
  });

  it('no-ops (no target created) when there are no skills to project', () => {
    setupHome('app-1', []); // canonical skills dir never created
    const target = path.join(tmp!, 'copilot-home', 'skills');

    expect(projectAppSkills('app-1', target)).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('drops a stale (dangling) projection when the skills disappear', () => {
    const canonicalSkills = setupHome('app-1', ['s1']);
    const target = path.join(tmp!, 'copilot-home', 'skills');
    expect(projectAppSkills('app-1', target)).toBeNull();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

    // Skills removed (canonical/skills gone) → the projection is cleaned up, even
    // though the symlink now dangles (lstat still sees it; existsSync would not).
    fs.rmSync(path.join(tmp!, '.shelf', 'apps', 'app-1', 'skills'), { recursive: true, force: true });
    expect(projectAppSkills('app-1', target)).toBeNull();
    expect(fs.existsSync(path.join(tmp!, 'copilot-home', 'skills'))).toBe(false);
    expect(() => fs.lstatSync(target)).toThrow();
    void canonicalSkills;
  });
});

describe('readUploadedImageAttachments', () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function upload(data: Buffer, mimeType?: string) {
    tmp = fs.mkdtempSync(path.join(realOs.tmpdir(), 'shelf-image-mime-'));
    const target = path.join(tmp, 'upload.bin');
    fs.writeFileSync(target, data);
    return { kind: 'image' as const, path: target, displayPath: 'upload.bin', name: 'upload.bin', mimeType };
  }

  // Signatures exercise MIME identification, not image decoding or validation.
  it.each([
    ['PNG', Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png'],
    ['JPEG', Buffer.from('ffd8ffe0', 'hex'), 'image/jpeg'],
    ['GIF87a', Buffer.from('GIF87a'), 'image/gif'],
    ['GIF89a', Buffer.from('GIF89a'), 'image/gif'],
    ['WebP', Buffer.from('524946460400000057454250', 'hex'), 'image/webp'],
  ])('corrects mislabeled %s bytes without changing the payload', async (_format, data, expectedMime) => {
    const attachment = upload(data, 'image/incorrect');

    await expect(readUploadedImageAttachments([attachment])).resolves.toEqual([{
      mimeType: expectedMime,
      data: data.toString('base64'),
    }]);
  });

  it('identifies JPEG bytes when MIME metadata is missing', async () => {
    const data = Buffer.from('ffd8ffe0', 'hex');

    await expect(readUploadedImageAttachments([upload(data)])).resolves.toEqual([{
      mimeType: 'image/jpeg', data: data.toString('base64'),
    }]);
  });

  it('preserves metadata for unrecognized formats in a mixed image submission', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const attachment = upload(svg, 'image/svg+xml');
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const pngPath = path.join(tmp!, 'image.png');
    fs.writeFileSync(pngPath, png);

    await expect(readUploadedImageAttachments([
      attachment,
      { ...attachment, path: pngPath, mimeType: 'image/png' },
    ])).resolves.toEqual([
      { mimeType: 'image/svg+xml', data: svg.toString('base64') },
      { mimeType: 'image/png', data: png.toString('base64') },
    ]);
  });

  it.each([undefined, ''])('keeps the PNG fallback for unknown bytes with MIME %j', async (mimeType) => {
    const data = Buffer.from('unknown image content');

    await expect(readUploadedImageAttachments([upload(data, mimeType)])).resolves.toEqual([{
      mimeType: 'image/png', data: data.toString('base64'),
    }]);
  });

  it('does not read ordinary file attachments', async () => {
    await expect(readUploadedImageAttachments([{
      kind: 'file', path: '/nonexistent/image.png', displayPath: 'image.png', name: 'image.png',
    }])).resolves.toEqual([]);
  });
});
