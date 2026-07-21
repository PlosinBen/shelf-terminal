import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Strip a leading `cwd/` prefix from an absolute path so the renderer shows
 * project-relative paths. Shared verbatim by the Claude and Copilot providers
 * (tool-input formatters + file-edit card subtitles). No-op when cwd or path
 * is empty, or when the path isn't under cwd.
 */
export function stripCwd(p: string, cwd: string): string {
  if (!cwd || !p) return p;
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/**
 * Resolve this app's projected skills plugin root on THIS machine —
 * `os.homedir()/.shelf/apps/<appId>/skills` — or null if `appId` is missing or
 * the dir hasn't been projected yet (no skills, or remote not yet synced). Both
 * ends self-resolve via `os.homedir()`, so the path is identical local/remote
 * with zero branching (see deployment#1 / feature §5.4). Providers point their
 * SDK at it: Claude `plugins[].path` = this root, Copilot `skillDirectories` =
 * `<root>/skills`.
 */
export function resolveSkillsPluginRoot(appId: string | undefined): string | null {
  if (!appId) return null;
  const root = path.join(os.homedir(), '.shelf', 'apps', appId, 'skills');
  try {
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * Layer-2 skill projection: symlink `target` → the canonical app-skill folders
 * (`<resolveSkillsPluginRoot>/skills`). The PROVIDER only declares `target` (its
 * CLI's scan path); this shared mechanic — owned by the agent-server, NOT the
 * provider (see the provider-boundary principle) — does the fs work.
 *
 * IDEMPOTENT (skips when the symlink is already correct) and ATOMIC (creates the
 * link at a temp name, then `rename`s over `target` — rename(2) is atomic, so N
 * concurrent cross-process callers, all keyed to the same appId target, collapse
 * to one real creation with no corruption). With a symlink, skill UPDATES need no
 * re-projection — the live source is followed.
 *
 * Pure-ish: side-effecting on the fs but returns an anomaly string (never throws,
 * never logs) so the caller fails loud in its own voice. Returns null on success
 * / benign no-op (no app context, or no skills to project yet).
 */
export function projectAppSkills(appId: string | undefined, target: string): string | null {
  const canonical = resolveSkillsPluginRoot(appId);
  const source = canonical ? path.join(canonical, 'skills') : null;
  try {
    // lstat (NOT existsSync) so a DANGLING symlink is still detected — existsSync
    // follows the link and would report a broken projection as absent.
    let isSymlink = false;
    try { isSymlink = fs.lstatSync(target).isSymbolicLink(); } catch { /* target absent */ }
    const cur = isSymlink ? fs.readlinkSync(target) : null;

    if (source && fs.existsSync(source)) {
      if (cur === source) return null; // already projected — idempotent no-op
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // A real (non-symlink) dir can't be replaced by rename → clear it first.
      if (!isSymlink && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      const tmp = `${target}.tmp-${process.pid}`;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* fresh */ }
      fs.symlinkSync(source, tmp, 'dir');
      fs.renameSync(tmp, target); // atomic replace of the symlink (or create)
      return null;
    }
    // No skills to project → drop a stale projection so the CLI stops listing them.
    if (cur !== null) fs.rmSync(target, { recursive: true, force: true });
    return null;
  } catch (err) {
    return `skill projection failed for app ${String(appId).slice(0, 8)} → ${target}: ${(err as Error)?.message ?? String(err)}`;
  }
}
