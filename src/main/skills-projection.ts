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

/** All files under `root`, as POSIX-relative paths (sorted) — ready to mirror
 *  onto a remote. POSIX separators so remote paths are correct from any host. */
export function listSkillFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
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
    fs.cpSync(src, dst, { recursive: true });
    // Touch the app's lease so the agent-server startup sweep (which may run
    // before the first heartbeat) doesn't reclaim a just-projected dir as an
    // orphan. The projection IS a liveness signal. See cleanup.ts / §5.9.
    fs.writeFileSync(path.join(path.dirname(dst), '.heartbeat'), '');
  } catch (err: any) {
    log.error('skills', `local projection failed for app ${appId.slice(0, 8)}: ${err?.message ?? err}`);
  }
}
