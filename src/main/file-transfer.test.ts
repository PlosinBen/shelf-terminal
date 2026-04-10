import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __test__,
  cleanupSession,
  clearUploads,
  maybeScheduleCleanup,
  uploadFile,
  __resetCleanupTracking,
  SESSION_STARTED_AT,
} from './file-transfer';

const {
  buildPaths,
  sanitizeFilename,
  shellSingleQuote,
  makePrefix,
  parseUploadPrefix,
  assertSafeCwd,
  buildRemoteUploadCmd,
} = __test__;

const LOCAL = { type: 'local' as const };

/**
 * Build a filename whose decoded prefix timestamp equals `ts` ms.
 * `parseUploadPrefix` does prefix.slice(0, -1) → base36 timestamp + 1 counter char,
 * so we hand-craft `${ts.toString(36)}0-<name>` to control the encoded ms exactly.
 *
 * Real Shelf prefixes are 9 chars (8-char base36 timestamp + 1 counter char),
 * which holds for any ms in the [1972, 2059) window. The test helpers below
 * use values inside [2020, 2059) so parseUploadPrefix accepts them.
 */
function nameWithTs(ts: number, suffix: string): string {
  return `${ts.toString(36)}0-${suffix}`;
}

// Well inside parseUploadPrefix's [2020, 2100) sane window, but well before
// SESSION_STARTED_AT, so cleanupSession with the default cutoff treats it as
// stale and deletes it.
const STALE_TS = Date.UTC(2024, 0, 1); // 2024-01-01
// In the future relative to test process startup — must be preserved.
const FRESH_TS = Date.UTC(2099, 0, 1);

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-cleanup-'));
  fs.mkdirSync(path.join(dir, '.tmp', 'shelf'), { recursive: true });
  return dir;
}

function rmTmpProject(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('sanitizeFilename', () => {
  it('keeps a normal filename intact', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('preserves spaces and shell-special chars (quoted at call site)', () => {
    expect(sanitizeFilename('My Report (final).pdf')).toBe('My Report (final).pdf');
  });

  it('replaces forward and back slashes', () => {
    expect(sanitizeFilename('a/b\\c.txt')).toBe('a_b_c.txt');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('foo\x01\x1fbar.txt')).toBe('foobar.txt');
  });

  it('falls back to "file" for empty input', () => {
    expect(sanitizeFilename('')).toBe('file');
  });

  it('falls back to "file" for "." and ".."', () => {
    expect(sanitizeFilename('.')).toBe('file');
    expect(sanitizeFilename('..')).toBe('file');
  });
});

describe('shellSingleQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellSingleQuote('hello')).toBe(`'hello'`);
  });

  it('escapes embedded single quotes using the POSIX trick', () => {
    expect(shellSingleQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('passes paths with spaces and metacharacters through unharmed', () => {
    expect(shellSingleQuote('/tmp/My Files/$x.txt')).toBe(`'/tmp/My Files/$x.txt'`);
  });
});

describe('buildPaths', () => {
  it('joins cwd, .tmp/shelf, and a prefixed filename', () => {
    const { remoteDir, remotePath } = buildPaths('/home/user/project', 'note.md');
    expect(remoteDir).toBe('/home/user/project/.tmp/shelf');
    expect(remotePath).toMatch(/^\/home\/user\/project\/\.tmp\/shelf\/[a-z0-9]+-note\.md$/);
  });

  it('strips trailing slashes from cwd', () => {
    const { remoteDir } = buildPaths('/var/work///', 'x.bin');
    expect(remoteDir).toBe('/var/work/.tmp/shelf');
  });

  it('sanitizes the source filename', () => {
    const { remotePath } = buildPaths('/tmp', 'a/b.txt');
    expect(remotePath).toMatch(/^\/tmp\/\.tmp\/shelf\/[a-z0-9]+-a_b\.txt$/);
  });
});

describe('makePrefix', () => {
  it('produces unique prefixes for back-to-back calls in the same millisecond', () => {
    // Without the counter, two calls inside one ms could collide.
    const prefixes = new Set<string>();
    for (let i = 0; i < 20; i++) prefixes.add(makePrefix());
    expect(prefixes.size).toBe(20);
  });

  it('uses base36 (lowercase alphanumeric only)', () => {
    expect(makePrefix()).toMatch(/^[a-z0-9]+$/);
  });
});

describe('parseUploadPrefix', () => {
  it('decodes the base36 timestamp from a real prefix+name', () => {
    const before = Date.now();
    const prefix = makePrefix(); // e.g. "lqy3k7sa9"
    const after = Date.now();
    const ts = parseUploadPrefix(`${prefix}-report.pdf`);
    expect(ts).not.toBeNull();
    // Decoded timestamp should sit within the call window.
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  it('round-trips makePrefix → parseUploadPrefix → millisecond', () => {
    const prefix = makePrefix();
    const ts = parseUploadPrefix(`${prefix}-anything.bin`);
    // Re-encode and compare.
    expect(ts!.toString(36)).toBe(prefix.slice(0, -1));
  });

  it('returns null for filenames without our prefix shape', () => {
    expect(parseUploadPrefix('report.pdf')).toBeNull();
    expect(parseUploadPrefix('UPPERCASE-NAME.txt')).toBeNull();
    expect(parseUploadPrefix('-leading.txt')).toBeNull();
    expect(parseUploadPrefix('a-too-short.txt')).toBeNull();
    expect(parseUploadPrefix('')).toBeNull();
  });

  it('rejects shorter-than-9-char prefixes (real prefixes are always 9 chars)', () => {
    // 'manually' is 8 chars and happens to be valid base36 — must NOT be parsed.
    expect(parseUploadPrefix('manually-placed.log')).toBeNull();
    expect(parseUploadPrefix('00-x.txt')).toBeNull();
  });

  it('rejects 9-char alphanumeric words whose decoded ms is outside the sane window', () => {
    // 'aaaaaaaaa' decodes to ~year 1995 — well before the 2020 floor.
    expect(parseUploadPrefix('aaaaaaaaa-foo.txt')).toBeNull();
  });

  it('survives filenames containing extra dashes', () => {
    const prefix = makePrefix();
    const ts = parseUploadPrefix(`${prefix}-some-name-with-dashes.log`);
    expect(ts).not.toBeNull();
  });
});

describe('assertSafeCwd', () => {
  it('accepts a normal path', () => {
    expect(() => assertSafeCwd('/home/user/proj')).not.toThrow();
  });

  it('rejects empty / whitespace cwd', () => {
    expect(() => assertSafeCwd('')).toThrow(/empty/);
    expect(() => assertSafeCwd('   ')).toThrow(/empty/);
  });

  it('rejects root cwd', () => {
    expect(() => assertSafeCwd('/')).toThrow(/root/);
  });
});

describe('buildRemoteUploadCmd', () => {
  it('chains mkdir, gitignore guard, and cat with single-quoted paths', () => {
    const cmd = buildRemoteUploadCmd(
      '/srv/proj',
      '/srv/proj/.tmp/shelf',
      '/srv/proj/.tmp/shelf/abc-x.txt',
    );
    expect(cmd).toBe(
      `mkdir -p '/srv/proj/.tmp/shelf' && { [ -f '/srv/proj/.tmp/.gitignore' ] || printf '*\\n' > '/srv/proj/.tmp/.gitignore'; } && cat > '/srv/proj/.tmp/shelf/abc-x.txt'`,
    );
  });

  it('groups the gitignore guard so mkdir failure does not still run printf', () => {
    // The brace group { ... } turns "mkdir && [ -f ] || printf && cat" into
    // "mkdir && (gitignore-stuff) && cat" — without it the `||` breaks the chain.
    const cmd = buildRemoteUploadCmd('/x', '/x/.tmp/shelf', '/x/.tmp/shelf/a-b.txt');
    expect(cmd).toMatch(/&& \{ \[ -f .+ \] \|\| printf .+; \} && cat /);
  });

  it('quotes paths that contain spaces and apostrophes', () => {
    const cmd = buildRemoteUploadCmd(
      `/home/user/My Proj's`,
      `/home/user/My Proj's/.tmp/shelf`,
      `/home/user/My Proj's/.tmp/shelf/abc-x.txt`,
    );
    // POSIX single-quote escape pattern: ' → '\''
    expect(cmd).toContain(`mkdir -p '/home/user/My Proj'\\''s/.tmp/shelf'`);
    expect(cmd).toContain(`cat > '/home/user/My Proj'\\''s/.tmp/shelf/abc-x.txt'`);
  });
});

// ── Local cleanup behaviour ──────────────────────────────────────────────
//
// These tests cover the actual filesystem ops in cleanupSession / clearUploads
// using a real temp dir + the local connector. Remote transports share the
// same listShelfDir/rm code path with `fs` swapped for `runRemote`, and that
// half is exercised by the SSH/Docker connector specs in connector/.

describe('cleanupSession (local)', () => {
  let dir: string;
  let shelfDir: string;

  beforeEach(() => {
    dir = makeTmpProject();
    shelfDir = path.join(dir, '.tmp', 'shelf');
  });

  afterEach(() => {
    rmTmpProject(dir);
  });

  it('deletes files older than the cutoff and leaves newer ones alone', async () => {
    const oldName = nameWithTs(STALE_TS, 'old.txt');
    const newName = nameWithTs(FRESH_TS, 'new.txt');
    fs.writeFileSync(path.join(shelfDir, oldName), 'old');
    fs.writeFileSync(path.join(shelfDir, newName), 'new');

    const removed = await cleanupSession(LOCAL, dir, Date.now());

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(shelfDir, oldName))).toBe(false);
    expect(fs.existsSync(path.join(shelfDir, newName))).toBe(true);
  });

  it('skips files that are not Shelf-prefixed (user-dropped scratch files)', async () => {
    const oldName = nameWithTs(STALE_TS, 'old.txt');
    const stranger = 'manually-placed.log';
    fs.writeFileSync(path.join(shelfDir, oldName), 'x');
    fs.writeFileSync(path.join(shelfDir, stranger), 'y');

    await cleanupSession(LOCAL, dir, Date.now());

    expect(fs.existsSync(path.join(shelfDir, oldName))).toBe(false);
    expect(fs.existsSync(path.join(shelfDir, stranger))).toBe(true);
  });

  it('returns 0 and does not throw when the shelf dir does not exist', async () => {
    fs.rmSync(shelfDir, { recursive: true, force: true });
    const removed = await cleanupSession(LOCAL, dir, Date.now());
    expect(removed).toBe(0);
  });

  it('keeps the shelf dir itself in place after cleaning', async () => {
    fs.writeFileSync(path.join(shelfDir, nameWithTs(STALE_TS, 'a.txt')), 'a');
    await cleanupSession(LOCAL, dir, Date.now());
    expect(fs.existsSync(shelfDir)).toBe(true);
  });

  it('refuses an empty cwd', async () => {
    await expect(cleanupSession(LOCAL, '', Date.now())).rejects.toThrow(/empty/);
  });

  it('refuses root cwd', async () => {
    await expect(cleanupSession(LOCAL, '/', Date.now())).rejects.toThrow(/root/);
  });
});

describe('clearUploads (local)', () => {
  let dir: string;
  let shelfDir: string;

  beforeEach(() => {
    dir = makeTmpProject();
    shelfDir = path.join(dir, '.tmp', 'shelf');
  });

  afterEach(() => {
    rmTmpProject(dir);
  });

  it('removes every entry regardless of timestamp', async () => {
    fs.writeFileSync(path.join(shelfDir, nameWithTs(STALE_TS, 'old.txt')), 'a');
    fs.writeFileSync(path.join(shelfDir, nameWithTs(FRESH_TS, 'new.txt')), 'b');
    // clearUploads is meant to be a *manual purge* — even unrelated files go.
    fs.writeFileSync(path.join(shelfDir, 'stranger.log'), 'c');

    const removed = await clearUploads(LOCAL, dir);

    expect(removed).toBe(3);
    expect(fs.readdirSync(shelfDir)).toHaveLength(0);
  });

  it('keeps the shelf directory itself', async () => {
    fs.writeFileSync(path.join(shelfDir, nameWithTs(STALE_TS, 'a.txt')), 'a');
    await clearUploads(LOCAL, dir);
    expect(fs.existsSync(shelfDir)).toBe(true);
  });

  it('returns 0 when there is nothing to clear', async () => {
    expect(await clearUploads(LOCAL, dir)).toBe(0);
  });

  it('refuses unsafe cwds', async () => {
    await expect(clearUploads(LOCAL, '')).rejects.toThrow(/empty/);
    await expect(clearUploads(LOCAL, '/')).rejects.toThrow(/root/);
  });
});

describe('uploadFile (local) — gitignore side effect', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpProject();
    // Remove the pre-created shelf dir so we exercise the auto-create path.
    fs.rmSync(path.join(dir, '.tmp'), { recursive: true, force: true });
  });

  afterEach(() => {
    rmTmpProject(dir);
  });

  it('writes .tmp/.gitignore on first upload', async () => {
    await uploadFile(LOCAL, dir, 'note.md', Buffer.from('hi'));
    const gi = path.join(dir, '.tmp', '.gitignore');
    expect(fs.existsSync(gi)).toBe(true);
    expect(fs.readFileSync(gi, 'utf-8')).toBe('*\n');
  });

  it('does not clobber an existing .tmp/.gitignore', async () => {
    fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.tmp', '.gitignore'), 'custom-rules\n');
    await uploadFile(LOCAL, dir, 'note.md', Buffer.from('hi'));
    expect(fs.readFileSync(path.join(dir, '.tmp', '.gitignore'), 'utf-8')).toBe(
      'custom-rules\n',
    );
  });
});

describe('maybeScheduleCleanup', () => {
  let dir: string;
  let shelfDir: string;

  beforeEach(() => {
    dir = makeTmpProject();
    shelfDir = path.join(dir, '.tmp', 'shelf');
    __resetCleanupTracking();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmTmpProject(dir);
  });

  it('schedules a cleanup that removes pre-session files after the delay', async () => {
    // SESSION_STARTED_AT is the test process startup; ts=1000 is far older.
    fs.writeFileSync(path.join(shelfDir, nameWithTs(STALE_TS, 'leftover.txt')), 'x');
    expect(SESSION_STARTED_AT).toBeGreaterThan(1_000);

    maybeScheduleCleanup('proj-a', LOCAL, dir);
    // Pre-delay: file should still be there.
    expect(fs.existsSync(path.join(shelfDir, nameWithTs(STALE_TS, 'leftover.txt')))).toBe(true);

    // Advance past the 3-second debounce; flush the scheduled async cleanup.
    await vi.advanceTimersByTimeAsync(3_500);

    expect(fs.existsSync(path.join(shelfDir, nameWithTs(STALE_TS, 'leftover.txt')))).toBe(false);
  });

  it('only schedules once per projectId — second call is a no-op', async () => {
    fs.writeFileSync(path.join(shelfDir, nameWithTs(STALE_TS, 'first.txt')), 'a');

    maybeScheduleCleanup('proj-b', LOCAL, dir);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(fs.existsSync(path.join(shelfDir, nameWithTs(STALE_TS, 'first.txt')))).toBe(false);

    // Drop a fresh "leftover" — a second call must NOT re-clean it.
    fs.writeFileSync(path.join(shelfDir, nameWithTs(STALE_TS, 'second.txt')), 'b');
    maybeScheduleCleanup('proj-b', LOCAL, dir);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(fs.existsSync(path.join(shelfDir, nameWithTs(STALE_TS, 'second.txt')))).toBe(true);
  });

  it('silently skips empty / root cwd instead of throwing', () => {
    expect(() => maybeScheduleCleanup('proj-c', LOCAL, '')).not.toThrow();
    expect(() => maybeScheduleCleanup('proj-d', LOCAL, '/')).not.toThrow();
  });
});
