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
