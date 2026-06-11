import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression for the ~6s startup stall: resolving the login-shell env used to
 * run `execFileSync(zsh, ['-ilc', 'env'])` at MODULE IMPORT time, synchronously
 * blocking the whole main-process boot before the window could even be created.
 * Resolution is now lazy (first getShellEnv) + a non-blocking background prime
 * after the window appears. These lock in: no spawn at import, lazy spawn on
 * first use, background prime, and the win32 no-op.
 */

const execFileSync = vi.fn();
const execFile = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
  execFile: (...args: unknown[]) => execFile(...args),
}));
vi.mock('@shared/logger', () => ({
  log: { info: vi.fn(), trace: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ENV_OUTPUT = 'PATH=/opt/homebrew/bin:/usr/bin\nLANG=en_US.UTF-8\n';

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  execFile.mockReset();
});

describe('shell-env resolution timing', () => {
  it('does NOT spawn a shell at import time (the startup-stall regression)', async () => {
    await import('./shell-env');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('getShellEnv resolves lazily (sync) on first call and memoizes', async () => {
    execFileSync.mockReturnValue(ENV_OUTPUT);
    const m = await import('./shell-env');

    const env = m.getShellEnv();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(env.PATH).toContain('/opt/homebrew/bin');

    m.getShellEnv();
    expect(execFileSync).toHaveBeenCalledTimes(1); // cached — no second spawn
  });

  it('primeShellEnv resolves in the background (async); later getShellEnv is free', async () => {
    execFile.mockImplementation((_shell: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, ENV_OUTPUT);
    });
    const m = await import('./shell-env');

    m.primeShellEnv();
    expect(execFile).toHaveBeenCalledTimes(1);

    const env = m.getShellEnv();
    expect(execFileSync).not.toHaveBeenCalled(); // prime already filled the cache
    expect(env.PATH).toContain('/opt/homebrew/bin');
  });

  it('is a no-op on win32 (returns process.env, never spawns)', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const m = await import('./shell-env');
      m.primeShellEnv();
      const env = m.getShellEnv();
      expect(execFile).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
      expect(env).toBe(process.env);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });
});

describe('pickUtf8Locale (region-agnostic UTF-8 LANG injection)', () => {
  const AVAIL = ['C', 'C.UTF-8', 'en_US.UTF-8', 'zh_TW.UTF-8', 'ja_JP.UTF-8', 'POSIX'];

  it('uses the OS region when its .UTF-8 locale exists (not hardcoded)', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'zh_TW', available: AVAIL })).toBe('zh_TW.UTF-8');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'ja_JP', available: AVAIL })).toBe('ja_JP.UTF-8');
  });

  it('strips @modifiers from AppleLocale (en_US@rg=… → en_US.UTF-8)', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'en_US@rg=uszzzz', available: AVAIL })).toBe('en_US.UTF-8');
  });

  it('falls back to en_US.UTF-8 when the region locale is not installed', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'de_DE', available: AVAIL })).toBe('en_US.UTF-8');
  });

  it('falls back to C.UTF-8 when neither region nor en_US exist (Linux-ish)', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: null, available: ['C', 'C.UTF-8', 'POSIX'] })).toBe('C.UTF-8');
  });

  it('matches verbatim across UTF-8/utf8 spelling (Linux lists utf8)', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'en_US', available: ['en_US.utf8', 'C.utf8'] })).toBe('en_US.utf8');
  });

  it('returns undefined (sets nothing) when no UTF-8 locale is available', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'zh_TW', available: ['C', 'POSIX'] })).toBeUndefined();
  });

  it('respects an existing locale: hasLocale=true → undefined (no override)', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: true, appleLocale: 'zh_TW', available: AVAIL })).toBeUndefined();
  });

  it('ignores malformed AppleLocale and falls back', async () => {
    const { pickUtf8Locale } = await import('./shell-env');
    expect(pickUtf8Locale({ hasLocale: false, appleLocale: 'garbage!!', available: AVAIL })).toBe('en_US.UTF-8');
  });
});

describe('shell-env locale injection wiring', () => {
  it('injects LANG when the login-shell env has none', async () => {
    // AppleLocale (`defaults read -g AppleLocale`) is the macOS-only path, so
    // pin platform to darwin — otherwise this runs differently on the Linux CI
    // host (readAppleLocale returns null → en_US.UTF-8 fallback).
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'defaults') return 'zh_TW\n';
        if (cmd === 'locale') return 'C\nC.UTF-8\nen_US.UTF-8\nzh_TW.UTF-8\n';
        return 'PATH=/usr/bin\n'; // the `zsh -ilc env` call — no LANG
      });
      const m = await import('./shell-env');
      const env = m.getShellEnv();
      expect(env.LANG).toBe('zh_TW.UTF-8');
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('does NOT inject (or probe locale) when the shell env already has LANG', async () => {
    execFileSync.mockReturnValue('PATH=/usr/bin\nLANG=en_US.UTF-8\n');
    const m = await import('./shell-env');
    const env = m.getShellEnv();
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(execFileSync).toHaveBeenCalledTimes(1); // only `zsh -ilc env`, no defaults/locale probes
  });
});
