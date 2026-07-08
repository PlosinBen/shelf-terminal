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

/**
 * Pick a UTF-8 locale to inject as LANG, region-agnostic. PURE (testable).
 *
 * Why we inject at all: GUI-launched apps (and the login shell they spawn) have
 * no LANG on macOS — Terminal.app/iTerm2 *inject* it at startup, it's not set by
 * any shell rc. Without a UTF-8 locale the spawned shell runs in C/POSIX and
 * mangles multi-byte (e.g. Chinese) input. Shelf is the terminal now, so it must
 * do the terminal-emulator's job. NEVER hardcode a region — derive from the OS.
 *
 * @param hasLocale   env already has LANG/LC_ALL/LC_CTYPE → return undefined (respect user)
 * @param appleLocale macOS `AppleLocale` (e.g. "zh_TW", "en_US@rg=…") or null
 * @param available   `locale -a` lines; we return a value VERBATIM from here so
 *                    setlocale never fails (matches macOS "UTF-8" / Linux "utf8")
 */
export function pickUtf8Locale(opts: {
  hasLocale: boolean;
  appleLocale: string | null;
  available: string[];
}): string | undefined {
  if (opts.hasLocale) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/-/g, '');
  const find = (wanted: string) => {
    const w = norm(wanted);
    return opts.available.find((a) => norm(a) === w);
  };
  if (opts.appleLocale) {
    const base = opts.appleLocale.split('@')[0].trim(); // strip @rg=…/@modifiers
    if (/^[a-z]{2,3}_[A-Za-z]{2,}$/.test(base)) {
      const m = find(`${base}.UTF-8`);
      if (m) return m;
    }
  }
  return find('en_US.UTF-8') ?? find('C.UTF-8') ?? undefined;
}

function readAppleLocale(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function readAvailableLocales(): string[] {
  try {
    return execFileSync('locale', ['-a'], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * Inject a UTF-8 LANG into the resolved env if it has no locale at all — the
 * terminal-emulator layer that `zsh -ilc env` structurally can't capture.
 * Mutates `env`. No-op on win32, or when the user already has LANG/LC_*.
 */
function ensureUtf8Locale(env: Record<string, string>): void {
  if (process.platform === 'win32') return;
  // Short-circuit BEFORE detection: user/Terminal-provided locale wins, and we
  // avoid spawning `defaults`/`locale` when not needed.
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) return;
  const locale = pickUtf8Locale({ hasLocale: false, appleLocale: readAppleLocale(), available: readAvailableLocales() });
  if (locale) {
    env.LANG = locale;
    log.info('connector', `injected UTF-8 locale LANG=${locale} (shell env had none)`);
  }
}

/**
 * Union two `:`-separated PATH strings, `primary` first, dropping duplicates.
 * PURE (testable). POSIX-only separator — applyResolved never runs on win32.
 */
export function mergePathDirs(primary: string | undefined, secondary: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [primary, secondary]) {
    if (!part) continue;
    for (const dir of part.split(':')) {
      if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); }
    }
  }
  return out.join(':');
}

function applyResolved(env: Record<string, string>, dt: number, mode: string): void {
  if (env.PATH) {
    ensureUtf8Locale(env);
    resolvedEnv = env;
    // Publish the login-shell PATH into THIS process's own env. GUI launch
    // (Dock/Finder) gives the main process a minimal PATH (no /usr/local/bin,
    // /opt/homebrew/bin…), so every LOCAL child that inherits the default env —
    // `execFile('docker'|'ssh'|'git', …)` with no explicit env, across the docker
    // connector and others — can't find the binary (spawn ENOENT). Correcting
    // process.env.PATH here, once, fixes them all with zero per-call-site
    // injection. Merge (resolved first, keep any process.env-only dir) rather
    // than replace, so we never drop a dir Electron added. Explicit getShellEnv()
    // consumers (interactive pty / agent-server) still get the FULL login env
    // (incl. LANG) — this only backfills the shared default env.
    process.env.PATH = mergePathDirs(env.PATH, process.env.PATH);
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
