import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseLoginPrompt, prefillLoginUrl, scrubLoginEnv, startLogin, LOGIN_TOKEN_ENV_KEYS } from './login';

/** Minimal fake ChildProcess: EventEmitter + stdout/stderr emitters + kill spy. */
function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { child.killed = true; return true; });
  return {
    child,
    stdout: (s: string) => child.stdout.emit('data', Buffer.from(s)),
    stderr: (s: string) => child.stderr.emit('data', Buffer.from(s)),
    close: (code: number | null) => child.emit('close', code),
    err: (e: Error) => child.emit('error', e),
  };
}

describe('parseLoginPrompt', () => {
  it('parses the primary headless prompt line', () => {
    const line = 'To authenticate, visit https://github.com/login/device and enter code 1E5E-903B.';
    expect(parseLoginPrompt(line)).toEqual({
      verificationUri: 'https://github.com/login/device',
      userCode: '1E5E-903B',
    });
  });

  it('parses the clipboard-fallback "enter the code … manually" line', () => {
    const line = 'Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code 1E5E-903B manually.';
    expect(parseLoginPrompt(line)).toEqual({
      verificationUri: 'https://github.com/login/device',
      userCode: '1E5E-903B',
    });
  });

  it('handles all-digit and all-letter codes', () => {
    expect(parseLoginPrompt('visit https://github.com/login/device and enter code 1234-5678')?.userCode).toBe('1234-5678');
    expect(parseLoginPrompt('visit https://github.com/login/device and enter code ABCD-WXYZ')?.userCode).toBe('ABCD-WXYZ');
  });

  it('supports GitHub Enterprise hosts', () => {
    const line = 'visit https://mycompany.ghe.com/login/device and enter code AB12-CD34.';
    expect(parseLoginPrompt(line)).toEqual({
      verificationUri: 'https://mycompany.ghe.com/login/device',
      userCode: 'AB12-CD34',
    });
  });

  it('returns null for noise / polling lines', () => {
    expect(parseLoginPrompt('Waiting for authorization...')).toBeNull();
    expect(parseLoginPrompt('Login failed: TypeError: fetch failed')).toBeNull();
    expect(parseLoginPrompt('')).toBeNull();
    // a URL but no code
    expect(parseLoginPrompt('See https://github.com/login/device for details')).toBeNull();
    // a code but no URL
    expect(parseLoginPrompt('Your code is 1E5E-903B')).toBeNull();
  });

  it('does not misfire on a code-like substring that is not a device code', () => {
    // 3-char groups should not match
    expect(parseLoginPrompt('visit https://x/login and enter code ABC-DEF')).toBeNull();
  });
});

describe('scrubLoginEnv', () => {
  it('removes every device-flow-short-circuiting token var', () => {
    const src = { PATH: '/usr/bin', COPILOT_GITHUB_TOKEN: 'a', GH_TOKEN: 'b', GITHUB_TOKEN: 'c', KEEP: 'x' };
    const out = scrubLoginEnv(src);
    for (const k of LOGIN_TOKEN_ENV_KEYS) expect(out[k]).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.KEEP).toBe('x');
    // does not mutate the source
    expect(src.GH_TOKEN).toBe('b');
  });
});

describe('startLogin', () => {
  it('spawns `copilot login`, scrubs token env, fires onPrompt once, resolves ok on exit 0', async () => {
    const f = makeFakeChild();
    const spawnFn = vi.fn(() => f.child) as any;
    const onPrompt = vi.fn();
    const runner = startLogin({
      cliPath: '/bin/copilot',
      onPrompt,
      env: { PATH: '/usr/bin', GH_TOKEN: 'stale' },
      spawnFn,
    });

    // spawned with `login` and a token-free env
    expect(spawnFn).toHaveBeenCalledOnce();
    const [bin, args, spawnOpts] = spawnFn.mock.calls[0];
    expect(bin).toBe('/bin/copilot');
    expect(args).toEqual(['login']);
    expect(spawnOpts.env.GH_TOKEN).toBeUndefined();
    expect(spawnOpts.env.PATH).toBe('/usr/bin');

    // prompt across a chunked line + a second matching line → onPrompt once
    f.stdout('To authenticate, visit https://github.com/login/de');
    f.stdout('vice and enter code 1E5E-903B.\nWaiting for authorization...\n');
    f.stderr('Please visit https://github.com/login/device and enter the code 1E5E-903B manually.\n');
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(onPrompt).toHaveBeenCalledWith({ verificationUri: 'https://github.com/login/device', userCode: '1E5E-903B' });

    f.close(0);
    await expect(runner.done).resolves.toEqual({ ok: true });
  });

  it('passes --host when provided', () => {
    const f = makeFakeChild();
    const spawnFn = vi.fn(() => f.child) as any;
    startLogin({ cliPath: '/bin/copilot', onPrompt: () => {}, host: 'https://x.ghe.com', spawnFn });
    expect(spawnFn.mock.calls[0][1]).toEqual(['login', '--host', 'https://x.ghe.com']);
  });

  it('cancel() kills the child and resolves cancelled', async () => {
    const f = makeFakeChild();
    const runner = startLogin({ cliPath: '/bin/copilot', onPrompt: () => {}, spawnFn: (() => f.child) as any });
    runner.cancel();
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    f.close(null); // process dies after SIGTERM
    await expect(runner.done).resolves.toEqual({ ok: false, cancelled: true });
  });

  it('non-zero exit → fail-loud error result mentioning missing prompt', async () => {
    const f = makeFakeChild();
    const log = vi.fn();
    const runner = startLogin({ cliPath: '/bin/copilot', onPrompt: () => {}, spawnFn: (() => f.child) as any, log });
    f.close(1);
    const res = await runner.done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exited with code 1/);
    expect(res.error).toMatch(/no verification prompt/);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('exited 1'));
  });

  it('process error → error result', async () => {
    const f = makeFakeChild();
    const runner = startLogin({ cliPath: '/bin/copilot', onPrompt: () => {}, spawnFn: (() => f.child) as any });
    f.err(new Error('ENOENT'));
    await expect(runner.done).resolves.toEqual({ ok: false, error: 'ENOENT' });
  });

  it('synchronous spawn throw → error result, no throw', async () => {
    const spawnFn = vi.fn(() => { throw new Error('EACCES'); }) as any;
    const log = vi.fn();
    const runner = startLogin({ cliPath: '/bad', onPrompt: () => {}, spawnFn, log });
    await expect(runner.done).resolves.toEqual({ ok: false, error: 'EACCES' });
    expect(() => runner.cancel()).not.toThrow();
  });
});

describe('prefillLoginUrl', () => {
  it('appends user_code as a query param', () => {
    expect(prefillLoginUrl({ verificationUri: 'https://github.com/login/device', userCode: '1E5E-903B' }))
      .toBe('https://github.com/login/device?user_code=1E5E-903B');
  });

  it('falls back to the bare uri when not parseable', () => {
    expect(prefillLoginUrl({ verificationUri: 'not a url', userCode: '1E5E-903B' })).toBe('not a url');
  });
});
