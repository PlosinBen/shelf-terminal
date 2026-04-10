import { describe, it, expect } from 'vitest';
import { __test__ } from './file-transfer';

const { buildPaths, sanitizeFilename, shellSingleQuote, makePrefix } = __test__;

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
