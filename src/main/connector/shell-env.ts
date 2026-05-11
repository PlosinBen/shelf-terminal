import fs from 'fs';
import { execFileSync } from 'child_process';
import { log } from '@shared/logger';

let resolvedEnv: Record<string, string> | null = null;

/**
 * Resolve the user's login shell environment.
 *
 * macOS/Linux GUI apps launched from Dock/Finder get a minimal env (no LANG,
 * partial PATH, etc.). We spawn a login shell once at startup to capture the
 * full env, matching what Terminal.app / iTerm2 do.
 */
function resolveShellEnv(): void {
  log.trace('shell-env', `resolveShellEnv start: platform=${process.platform} SHELL=${process.env.SHELL ?? '<unset>'} processPATH=${process.env.PATH ?? '<unset>'}`);
  if (process.platform === 'win32') {
    log.trace('shell-env', 'resolveShellEnv skipped (win32)');
    return;
  }
  const t0 = Date.now();
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    log.trace('shell-env', `resolveShellEnv spawning ${shell} -ilc env`);
    // Packaged app cold-start 從 Dock 啟動時，`zsh -ilc env` 在使用者 .zshrc
    // 較重（oh-my-zsh + nvm + pyenv...）的情況下可量到 7s 等級。Terminal
    // warm cache 跑通常 < 3s，但 GUI cold start 慢一倍以上很常見。
    const output = execFileSync(shell, ['-ilc', 'env'], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const dt = Date.now() - t0;
    const env: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    log.trace('shell-env', `resolveShellEnv ok in ${dt}ms, ${Object.keys(env).length} vars, PATH=${env.PATH ?? '<missing>'}`);
    if (env.PATH) {
      resolvedEnv = env;
      log.info('connector', `resolved shell env (${Object.keys(env).length} vars)`);
    } else {
      log.trace('shell-env', 'resolveShellEnv WARNING: env.PATH missing, NOT caching');
    }
  } catch (err) {
    const dt = Date.now() - t0;
    log.trace('shell-env', `resolveShellEnv FAILED in ${dt}ms: ${err instanceof Error ? err.message : String(err)}`);
    log.info('connector', `failed to resolve shell env, using process.env: ${err}`);
  }
}

// Run once on import
resolveShellEnv();

/** Return the full login shell env (macOS/Linux) or process.env (Windows). */
export function getShellEnv(): Record<string, string> {
  const env = resolvedEnv ?? (process.env as Record<string, string>);
  log.trace('shell-env', `getShellEnv called: source=${resolvedEnv ? 'resolved' : 'process.env-fallback'} PATH=${env.PATH ?? '<missing>'}`);
  return env;
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
