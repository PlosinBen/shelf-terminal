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
  if (process.platform === 'win32') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const output = execFileSync(shell, ['-ilc', 'env'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    if (env.PATH) {
      resolvedEnv = env;
      log.info('connector', `resolved shell env (${Object.keys(env).length} vars)`);
    }
  } catch (err) {
    log.info('connector', `failed to resolve shell env, using process.env: ${err}`);
  }
}

// Run once on import
resolveShellEnv();

/** Return the full login shell env (macOS/Linux) or process.env (Windows). */
export function getShellEnv(): Record<string, string> {
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
