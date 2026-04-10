import { describe, it, expect } from 'vitest';
import { __test__ } from './file-transfer';

const {
  buildPaths,
  sanitizeFilename,
  shellSingleQuote,
  makePrefix,
  parseUploadPrefix,
  assertSafeCwd,
  buildRemoteUploadCmd,
} = __test__;

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
    expect(parseUploadPrefix('UPPERCASE-name.txt')).toBeNull();
    expect(parseUploadPrefix('-leading.txt')).toBeNull();
    expect(parseUploadPrefix('a-too-short.txt')).toBeNull();
    expect(parseUploadPrefix('')).toBeNull();
  });

  it('returns null when the timestamp portion decodes to 0', () => {
    // "0" + counter "0" → timestampPart is "" or decodes to 0.
    expect(parseUploadPrefix('00-x.txt')).toBeNull();
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
