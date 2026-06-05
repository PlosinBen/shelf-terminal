import fs from 'fs';
import { execFile, execFileSync } from 'child_process';
import { log } from '@shared/logger';

let resolvedEnv: Record<string, string> | null = null;
let attempted = false; // a resolution attempt (sync or async) has completed
let priming = false;   // an async prime is currently in flight

/**
 * Resolve the user's login shell environment.
 *
 * macOS/Linux GUI apps launched from Dock/Finder get a minimal env (no LANG,
 * partial PATH, etc.). We spawn a login shell to capture the full env, matching
 * what Terminal.app / iTerm2 do — needed by every spawned pty / agent-server /
 * ssh / docker (the local client still needs PATH to find its own binary).
 *
 * IMPORTANT: this is NOT run at import time. A cold `zsh -ilc env` on a heavy
 * shell (oh-my-zsh + nvm + pyenv…) costs ~6s, and doing it synchronously at
 * import blocked the ENTIRE main-process boot — window included — even though
 * projects start disconnected and nothing needs the env until the user
 * connects. So: `primeShellEnv()` warms it asynchronously after the window is
 * shown, and `getShellEnv()` falls back to a one-time sync resolve if it's
 * somehow needed before the prime finishes. See GOTCHAS.
 */
function parseEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

function applyResolved(env: Record<string, string>, dt: number, mode: string): void {
  if (env.PATH) {
    resolvedEnv = env;
    log.info('connector', `resolved shell env (${Object.keys(env).length} vars) in ${dt}ms [${mode}]`);
  } else {
    log.trace('shell-env', `resolve(${mode}) WARNING: env.PATH missing, NOT caching`);
  }
}

/**
 * Synchronous resolve — blocks the calling thread. Only used as the fallback
 * when getShellEnv() is needed before the background prime has finished.
 * Memoized via `attempted`.
 */
function resolveSync(): void {
  if (attempted) return;
  attempted = true;
  if (process.platform === 'win32') return;
  const t0 = Date.now();
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    log.trace('shell-env', `resolveSync spawning ${shell} -ilc env`);
    const output = execFileSync(shell, ['-ilc', 'env'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    applyResolved(parseEnv(output), Date.now() - t0, 'sync');
  } catch (err) {
    log.info('connector', `failed to resolve shell env (sync), using process.env: ${err}`);
  }
}

/**
 * Kick off shell-env resolution in the background (non-blocking). Call once
 * after the window is shown so the first connection is usually instant without
 * blocking startup. No-op on win32, or once a resolution has been attempted /
 * is already in flight.
 */
export function primeShellEnv(): void {
  if (attempted || priming || process.platform === 'win32') return;
  priming = true;
  const t0 = Date.now();
  const shell = process.env.SHELL || '/bin/zsh';
  log.trace('shell-env', `primeShellEnv spawning ${shell} -ilc env (async)`);
  execFile(
    shell,
    ['-ilc', 'env'],
    { encoding: 'utf-8', timeout: 15000, env: { ...process.env }, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      priming = false;
      if (attempted) return; // a sync fallback resolved while we were running
      attempted = true;
      if (err) {
        log.info('connector', `failed to resolve shell env (prime), using process.env: ${err}`);
        return;
      }
      applyResolved(parseEnv(stdout), Date.now() - t0, 'prime');
    },
  );
}

/** Return the full login shell env (macOS/Linux) or process.env (Windows). */
export function getShellEnv(): Record<string, string> {
  if (!attempted) resolveSync();
  return resolvedEnv ?? (process.env as Record<string, string>);
}

/** Resolve the user's login shell binary. */
export function resolveShell(): string {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '/bin/sh';
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
