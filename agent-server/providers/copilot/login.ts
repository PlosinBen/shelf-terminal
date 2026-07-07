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
