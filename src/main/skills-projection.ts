import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import { log } from '@shared/logger';

/**
 * Local projection of the app-level skills source onto the per-app consumption
 * path the agent-server reads (see DECISION #70 / feature §5.4–§5.9):
 *
 *   <userData>/skills/  →  ~/.shelf/apps/<appId>/skills/   (whole-tree mirror)
 *
 * This is the L2 (local) transport of the unified projection — the agent-server
 * always reads `os.homedir()/.shelf/apps/<appId>/skills`, with zero local/remote
 * branching; L3 swaps this fs copy for scp/docker cp/wsl to remote machines.
 * Mirror semantics (wipe + copy) cover deletes/renames for free; the source is
 * the only truth, so the projection is disposable.
 */

function skillsSourceRoot(): string {
  return path.join(app.getPath('userData'), 'skills');
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
  } catch (err: any) {
    log.error('skills', `local projection failed for app ${appId.slice(0, 8)}: ${err?.message ?? err}`);
  }
}
