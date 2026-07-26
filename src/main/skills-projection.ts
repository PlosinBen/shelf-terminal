import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { app } from 'electron';
import { log } from '@shared/logger';

/**
 * Local projection of the app-level skills source onto the per-app consumption
 * path the agent-server reads (see deployment#1 / feature §5.4–§5.9):
 *
 *   <userData>/skills/  →  ~/.shelf/apps/<appId>/skills/   (whole-tree mirror)
 *
 * This is the L2 (local) transport of the unified projection — the agent-server
 * always reads `os.homedir()/.shelf/apps/<appId>/skills`, with zero local/remote
 * branching; L3 swaps this fs copy for scp/docker cp/wsl to remote machines.
 * Mirror semantics (wipe + copy) cover deletes/renames for free; the source is
 * the only truth, so the projection is disposable.
 */

export function skillsSourceRoot(): string {
  return path.join(app.getPath('userData'), 'skills');
}

// The per-skill `.locked` marker is a MAIN-only control file: lock enforcement
// reads the source folder (skills-store `isSkillLocked`), never the projection.
// So it must NOT travel into the consumption tree — excluding it keeps the
// projected/synced bytes (and the tree hash) invariant under lock/unlock, so a
// pure lock toggle never perturbs the hash or triggers a re-sync.
const LOCK_MARKER = '.locked';

// The per-skill `.disabled` marker is ALSO a main-only control file, but its
// meaning is the OPPOSITE of `.locked`: a disabled skill's WHOLE folder is
// dropped from the projected/synced tree (so no live agent sees it and its
// description leaves context). So unlike `.locked` (engineered hash-invariant),
// disabling MUST change the file list + tree hash → the `.synced` gate re-syncs
// and onSkillsChanged() hot-reloads live sessions. See feature note.
const DISABLED_MARKER = '.disabled';

/** Absolute paths of DISABLED skill folders under `root` (each contains a
 *  `.disabled` marker). Computed by an inline marker check on `root/skills/*` so
 *  projection stays self-contained (no skills-store import). */
function disabledSkillDirs(root: string): Set<string> {
  const out = new Set<string>();
  const collection = path.join(root, 'skills');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(collection, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && fs.existsSync(path.join(collection, e.name, DISABLED_MARKER))) {
      out.add(path.join(collection, e.name));
    }
  }
  return out;
}

/** All files under `root`, as POSIX-relative paths (sorted) — ready to mirror
 *  onto a remote. POSIX separators so remote paths are correct from any host.
 *  DISABLED skill folders are dropped entirely (so remote + hash both reflect
 *  the exclusion); the `.locked` / `.disabled` markers themselves never travel. */
export function listSkillFilesRel(root: string): string[] {
  const out: string[] = [];
  const disabledDirs = disabledSkillDirs(root);
  const walk = (dir: string, rel: string) => {
    if (disabledDirs.has(dir)) return; // skip the whole disabled skill subtree
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && e.name !== LOCK_MARKER && e.name !== DISABLED_MARKER) out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Content fingerprint of the skills tree (sorted relpath + bytes). Drives the
 *  remote `.synced` incremental gate — re-sync only when this changes. */
export function hashSkillsTree(root: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of listSkillFilesRel(root)) {
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(path.join(root, rel)));
    } catch {
      /* unreadable file — relpath alone still perturbs the hash */
    }
    h.update('\0');
  }
  return h.digest('hex');
}

/** The local consumption path (Claude plugin root) for this app instance. */
export function localSkillsTarget(appId: string): string {
  return path.join(os.homedir(), '.shelf', 'apps', appId, 'skills');
}

/**
 * Project the skills source onto `~/.shelf/apps/<appId>/skills` on THIS machine.
 * No-op when there's no source yet (user has created no skills). Best-effort —
 * never throws into the session-start path.
 */
export function projectSkillsLocal(appId: string): void {
  const src = skillsSourceRoot();
  const dst = localSkillsTarget(appId);
  try {
    if (!fs.existsSync(src)) return;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // Exclude main-only control markers (`.locked` / `.disabled`) AND the entire
    // folder of any DISABLED skill. cpSync does not recurse into a dir the filter
    // rejects, so returning false for `skills/<name>` skips its whole subtree.
    const disabledDirs = disabledSkillDirs(src);
    fs.cpSync(src, dst, {
      recursive: true,
      filter: (s) => {
        const base = path.basename(s);
        if (base === LOCK_MARKER || base === DISABLED_MARKER) return false;
        if (disabledDirs.has(s)) return false;
        return true;
      },
    });
    // Touch the app's lease so the agent-server startup sweep (which may run
    // before the first heartbeat) doesn't reclaim a just-projected dir as an
    // orphan. The projection IS a liveness signal. See cleanup.ts / §5.9.
    fs.writeFileSync(path.join(path.dirname(dst), '.heartbeat'), '');
  } catch (err: any) {
    log.error('skills', `local projection failed for app ${appId.slice(0, 8)}: ${err?.message ?? err}`);
  }
}
