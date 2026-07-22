/**
 * Copilot interactive device-flow login.
 *
 * The SDK exposes NO interactive account login (its only account-auth RPC,
 * `account.login`, just persists an already-acquired token). The browser
 * device flow lives in the CLI's `copilot login` command, which — even headless
 * (no TTY / no browser / no clipboard) — prints a stable line and then polls:
 *
 *   To authenticate, visit https://github.com/login/device and enter code 1E5E-903B.
 *   Waiting for authorization...
 *
 * So we drive login by spawning `copilot login`, parsing that line out of its
 * stdout, and routing the URL + code to the LOCAL Shelf UI (necessary for the
 * remote case: the CLI runs on the remote, the user's browser is local). The
 * CLI owns the OAuth client_id — we never touch it. Success is signalled by the
 * process exiting 0 (credential written to the machine the CLI runs on).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/** The verification prompt extracted from `copilot login` stdout. */
export interface LoginPrompt {
  /** GitHub device-activation page, e.g. `https://github.com/login/device`. */
  verificationUri: string;
  /** One-time user code, e.g. `1E5E-903B`. */
  userCode: string;
}

// GitHub device user codes are 8 chars in two dash-separated groups (letters +
// digits). This is the stable anchor; the surrounding prose ("visit … enter
// code …" vs "Please visit … enter the code … manually") varies, so we key on
// the code and grab the nearest https URL on the same line.
const USER_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_RE = /(https:\/\/\S+)/;

/** Strip trailing sentence punctuation the CLI appends after the URL. */
function trimUrl(raw: string): string {
  return raw.replace(/[.,;)]+$/, '');
}

/**
 * Parse one line of `copilot login` stdout into a {@link LoginPrompt}, or null
 * if the line isn't the verification prompt. Pure — unit-tested in isolation.
 */
export function parseLoginPrompt(line: string): LoginPrompt | null {
  const codeMatch = USER_CODE_RE.exec(line);
  if (!codeMatch) return null;
  const urlMatch = URL_RE.exec(line);
  if (!urlMatch) return null;
  return {
    verificationUri: trimUrl(urlMatch[1]),
    userCode: codeMatch[1],
  };
}

/**
 * Env vars that make `copilot login` SHORT-CIRCUIT the browser device flow and
 * use a token instead (checked in this precedence order per `copilot help
 * environment`). For INTERACTIVE login we must strip all of them, or the CLI
 * silently reuses a stale/ambient token and never opens the browser.
 */
export const LOGIN_TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/** Return a copy of `env` with the device-flow-short-circuiting token vars removed. */
export function scrubLoginEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of LOGIN_TOKEN_ENV_KEYS) delete out[k];
  return out;
}

/** Terminal outcome of a login run. */
export interface LoginResult {
  ok: boolean;
  /** true when we killed the process via {@link LoginRunner.cancel}. */
  cancelled?: boolean;
  error?: string;
}

/** Handle over a running `copilot login` child. */
export interface LoginRunner {
  /** Kill the login child; `done` then resolves `{ ok:false, cancelled:true }`. */
  cancel(): void;
  /** Resolves when the child exits: `ok` on exit 0, else an error/cancel result. */
  done: Promise<LoginResult>;
}

export interface StartLoginOpts {
  /** Resolved `copilot` binary path (from resolveCopilotCliPath). */
  cliPath: string;
  /** Called ONCE with the verification URL + code parsed out of the CLI output. */
  onPrompt: (p: LoginPrompt) => void;
  /** GitHub host (GHE data-residency). Omitted → CLI defaults to github.com. */
  host?: string;
  /** Base env (default `process.env`); token vars are scrubbed regardless. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to node's `spawn`. */
  spawnFn?: typeof nodeSpawn;
  /** Diagnostic sink (fail-loud). */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

/** Split a chunked byte stream into complete lines, invoking `onLine` per line. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

/**
 * Spawn `copilot login` and drive the device flow. Parses the verification
 * prompt out of BOTH stdout and stderr (headless CLI may print to either),
 * fires `onPrompt` once, and resolves `done` on process exit. The CLI keeps
 * polling and writes the credential to the machine it runs on (local or remote)
 * — so a successful authorization ends with exit 0.
 */
export function startLogin(opts: StartLoginOpts): LoginRunner {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const log = opts.log ?? (() => {});
  const args = ['login', ...(opts.host ? ['--host', opts.host] : [])];
  let child: ChildProcess;
  try {
    child = spawnFn(opts.cliPath, args, {
      env: scrubLoginEnv(opts.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // Spawn threw synchronously (bad path / EACCES). Fail loud, resolve error.
    log('error', `copilot login spawn threw: ${err?.message ?? err}`);
    return { cancel() {}, done: Promise.resolve({ ok: false, error: String(err?.message ?? err) }) };
  }

  let cancelled = false;
  let promptSeen = false;
  const handleLine = (line: string) => {
    if (!promptSeen) {
      const parsed = parseLoginPrompt(line);
      if (parsed) {
        promptSeen = true;
        log('info', `copilot login prompt: code=${parsed.userCode} uri=${parsed.verificationUri}`);
        opts.onPrompt(parsed);
      }
    }
  };
  child.stdout?.on('data', lineSplitter(handleLine));
  child.stderr?.on('data', lineSplitter(handleLine));

  const done = new Promise<LoginResult>((resolve) => {
    child.on('error', (err) => {
      log('error', `copilot login process error: ${err?.message ?? err}`);
      resolve({ ok: false, error: String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      if (cancelled) {
        resolve({ ok: false, cancelled: true });
      } else if (code === 0) {
        resolve({ ok: true });
      } else {
        // Non-zero without a prompt usually means an env/network failure BEFORE
        // the device flow (fail loud so the UI shows something actionable).
        const detail = promptSeen ? '' : ' (no verification prompt was emitted)';
        log('error', `copilot login exited ${code}${detail}`);
        resolve({ ok: false, error: `copilot login exited with code ${code}${detail}` });
      }
    });
  });

  return {
    cancel() {
      cancelled = true;
      child.kill('SIGTERM');
    },
    done,
  };
}

/**
 * Build a pre-filled device-activation URL so the user need not type the code:
 * `https://github.com/login/device?user_code=XXXX-XXXX`. Falls back to the bare
 * verificationUri when it can't be parsed as a URL (caller still shows the code).
 */
export function prefillLoginUrl(p: LoginPrompt): string {
  try {
    const u = new URL(p.verificationUri);
    u.searchParams.set('user_code', p.userCode);
    return u.toString();
  } catch {
    return p.verificationUri;
  }
}
