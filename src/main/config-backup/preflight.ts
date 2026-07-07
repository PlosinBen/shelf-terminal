import simpleGit, { type SimpleGit } from 'simple-git';

/**
 * Fail-loud preflight for config backup. We depend on the machine's own `git`
 * and the machine's own git credentials (Shelf holds no secret), so before
 * binding a remote / first Backup we verify, with the REAL reason surfaced:
 *   (a) `git` is present on PATH, and
 *   (b) the remote is reachable + authenticates (`git ls-remote`, no clone).
 *
 * Never a mid-push crash, never a silent swallow — a typed reason + the raw git
 * stderr flow up to the UI.
 */

export type PreflightReason = 'no-git' | 'remote';

export type PreflightResult =
  | { ok: true; gitVersion: string }
  | { ok: false; reason: PreflightReason; message: string };

/** Thrown at call sites that prefer an exception to a result (carries the reason). */
export class ConfigBackupPreflightError extends Error {
  constructor(public readonly reason: PreflightReason, message: string) {
    super(message);
    this.name = 'ConfigBackupPreflightError';
  }
}

export async function checkGitAvailable(
  git: SimpleGit = simpleGit(),
): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  try {
    const v = await git.version();
    return { ok: true, version: String(v) };
  } catch (err: any) {
    return {
      ok: false,
      message:
        'git was not found on this machine. Config Backup needs git installed and on your PATH. ' +
        `(${err?.message ?? String(err)})`,
    };
  }
}

export async function checkRemoteReachable(
  remoteUrl: string,
  git: SimpleGit = simpleGit(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await git.listRemote([remoteUrl]);
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      message:
        `Could not reach the backup remote (${remoteUrl}). Check the URL and that your git ` +
        `credentials are set up (SSH key or credential helper), then try again. ` +
        `git said: ${err?.message ?? String(err)}`,
    };
  }
}

/** git present AND remote reachable. Returns the first failing reason. */
export async function preflight(
  remoteUrl: string,
  git: SimpleGit = simpleGit(),
): Promise<PreflightResult> {
  const g = await checkGitAvailable(git);
  if (!g.ok) return { ok: false, reason: 'no-git', message: g.message };
  const r = await checkRemoteReachable(remoteUrl, git);
  if (!r.ok) return { ok: false, reason: 'remote', message: r.message };
  return { ok: true, gitVersion: g.version };
}

/** Preflight, throwing ConfigBackupPreflightError on failure. */
export async function assertPreflight(remoteUrl: string, git: SimpleGit = simpleGit()): Promise<void> {
  const res = await preflight(remoteUrl, git);
  if (!res.ok) throw new ConfigBackupPreflightError(res.reason, res.message);
}
