import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAvailableTypes } from './index';
import { wrapPty } from './wrap-pty';
import {
  makePrefix, parseUploadPrefix, sanitizeFilename, shellSingleQuote,
  assertSafeCwd, buildPaths, buildRemoteUploadCmd, normalizeCwd,
} from './file-utils';

// ── getAvailableTypes ──

describe('getAvailableTypes', () => {
  it('includes local, ssh, docker on non-win32', () => {
    // Current platform is macOS in test env
    if (process.platform !== 'win32') {
      const types = getAvailableTypes();
      expect(types).toContain('local');
      expect(types).toContain('ssh');
      expect(types).toContain('docker');
      expect(types).not.toContain('wsl');
    }
  });
});

// ── wrapPty ──

describe('wrapPty', () => {
  function makeFakePty() {
    const dataCallbacks: Array<(data: string) => void> = [];
    const exitCallbacks: Array<(info: { exitCode: number }) => void> = [];
    return {
      pty: {
        onData(cb: (data: string) => void) {
          dataCallbacks.push(cb);
          return { dispose: () => { const i = dataCallbacks.indexOf(cb); if (i >= 0) dataCallbacks.splice(i, 1); } };
        },
        onExit(cb: (info: { exitCode: number }) => void) {
          exitCallbacks.push(cb);
          return { dispose: () => { const i = exitCallbacks.indexOf(cb); if (i >= 0) exitCallbacks.splice(i, 1); } };
        },
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      } as any,
      emitData(data: string) { dataCallbacks.forEach((cb) => cb(data)); },
      emitExit(exitCode: number) { exitCallbacks.forEach((cb) => cb({ exitCode })); },
    };
  }

  it('forwards write to underlying pty', () => {
    const { pty } = makeFakePty();
    const shell = wrapPty(pty);
    shell.write('hello');
    expect(pty.write).toHaveBeenCalledWith('hello');
  });

  it('forwards resize to underlying pty', () => {
    const { pty } = makeFakePty();
    const shell = wrapPty(pty);
    shell.resize(120, 40);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('forwards kill to underlying pty', () => {
    const { pty } = makeFakePty();
    const shell = wrapPty(pty);
    shell.kill();
    expect(pty.kill).toHaveBeenCalled();
  });

  it('relays onData events', () => {
    const { pty, emitData } = makeFakePty();
    const shell = wrapPty(pty);
    const received: string[] = [];
    shell.onData((data) => received.push(data));
    emitData('foo');
    emitData('bar');
    expect(received).toEqual(['foo', 'bar']);
  });

  it('relays onExit with flattened exitCode', () => {
    const { pty, emitExit } = makeFakePty();
    const shell = wrapPty(pty);
    const codes: number[] = [];
    shell.onExit((code) => codes.push(code));
    emitExit(42);
    expect(codes).toEqual([42]);
  });

  it('dispose stops relaying events', () => {
    const { pty, emitData } = makeFakePty();
    const shell = wrapPty(pty);
    const received: string[] = [];
    const disposable = shell.onData((data) => received.push(data));
    emitData('before');
    disposable.dispose();
    emitData('after');
    expect(received).toEqual(['before']);
  });
});

// ── file-utils (these duplicate some file-transfer.test.ts coverage but ──
// ── verify the canonical source in connector/file-utils.ts)               ──

describe('file-utils', () => {
  describe('makePrefix', () => {
    it('returns a non-empty string', () => {
      expect(makePrefix().length).toBeGreaterThan(0);
    });

    it('produces unique prefixes on consecutive calls', () => {
      const a = makePrefix();
      const b = makePrefix();
      expect(a).not.toBe(b);
    });
  });

  describe('parseUploadPrefix', () => {
    it('parses a valid prefix', () => {
      const prefix = makePrefix();
      const name = `${prefix}-test.txt`;
      const ts = parseUploadPrefix(name);
      expect(ts).toBeTypeOf('number');
      expect(ts).toBeGreaterThan(0);
    });

    it('returns null for non-shelf filenames', () => {
      expect(parseUploadPrefix('readme.md')).toBeNull();
      expect(parseUploadPrefix('short-x.txt')).toBeNull();
    });
  });

  describe('sanitizeFilename', () => {
    it('strips path separators', () => {
      expect(sanitizeFilename('a/b\\c')).toBe('a_b_c');
    });
    it('replaces empty/dot names with "file"', () => {
      expect(sanitizeFilename('')).toBe('file');
      expect(sanitizeFilename('.')).toBe('file');
      expect(sanitizeFilename('..')).toBe('file');
    });
  });

  describe('shellSingleQuote', () => {
    it('wraps in single quotes', () => {
      expect(shellSingleQuote('hello')).toBe("'hello'");
    });
    it('escapes embedded single quotes', () => {
      expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
    });
  });

  describe('assertSafeCwd', () => {
    it('throws on empty cwd', () => {
      expect(() => assertSafeCwd('')).toThrow('empty');
    });
    it('throws on root cwd', () => {
      expect(() => assertSafeCwd('/')).toThrow('root');
    });
    it('accepts normal paths', () => {
      expect(() => assertSafeCwd('/home/user/project')).not.toThrow();
    });
  });

  describe('buildPaths', () => {
    it('returns remoteDir and remotePath under .tmp/shelf', () => {
      const { remoteDir, remotePath } = buildPaths('/home/user', 'test.png');
      expect(remoteDir).toBe('/home/user/.tmp/shelf');
      expect(remotePath).toMatch(/^\/home\/user\/\.tmp\/shelf\/[a-z0-9]+-test\.png$/);
    });
  });

  describe('buildRemoteUploadCmd', () => {
    it('includes mkdir, gitignore guard, and cat', () => {
      const cmd = buildRemoteUploadCmd('/home/u', '/home/u/.tmp/shelf', '/home/u/.tmp/shelf/abc-f.txt');
      expect(cmd).toContain('mkdir -p');
      expect(cmd).toContain('.gitignore');
      expect(cmd).toContain('cat >');
    });
  });

  describe('normalizeCwd', () => {
    it('strips trailing slashes', () => {
      expect(normalizeCwd('/home/user/')).toBe('/home/user');
      expect(normalizeCwd('/home/user')).toBe('/home/user');
    });
  });
});
