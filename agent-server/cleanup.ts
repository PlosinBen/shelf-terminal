import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Heartbeat-lease cleanup of ~/.shelf (DECISION #70 / feature section 5.9).
 * Runs in agent-server at startup (same machine as files -> own clock, no skew;
 * client never touches remote fs). Replaces the old "delete every version but
 * current" eager cleanup, which thrashed when two apps on different versions
 * shared a remote. The lease is the `.heartbeat` file the live agent-server
 * touches every beat; a dir survives while any live agent-server keeps it fresh.
 */

const RECLAIM_MS = 24 * 60 * 60 * 1000; // 1 day
const VERSION_FLOOR = 2; // keep current + previous

export interface VersionEntry {
  name: string;
  deployedMtime: number | null;
  heartbeatMtime: number | null;
}
export interface AppEntry {
  id: string;
  heartbeatMtime: number | null;
}

/** Numeric-segment version compare; >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Versions to delete. Keep current, top-floorCount by version, or fresh lease.
 *  Only delete dirs with `.deployed` (a half-finished transfer is left alone). */
export function planVersionSweep(
  entries: VersionEntry[],
  currentVersion: string,
  now: number,
  reclaimMs = RECLAIM_MS,
  floorCount = VERSION_FLOOR,
): string[] {
  const floor = new Set(
    [...entries].sort((a, b) => compareVersions(b.name, a.name)).slice(0, floorCount).map((e) => e.name),
  );
  const del: string[] = [];
  for (const e of entries) {
    if (e.name === currentVersion || floor.has(e.name)) continue;
    if (e.deployedMtime == null) continue;
    const lastTouch = e.heartbeatMtime ?? e.deployedMtime;
    if (now - lastTouch < reclaimMs) continue;
    del.push(e.name);
  }
  return del;
}

/** App dirs to delete: keep current + fresh-lease, delete the rest (orphans). */
export function planAppsSweep(
  entries: AppEntry[],
  currentAppId: string | undefined,
  now: number,
  reclaimMs = RECLAIM_MS,
): string[] {
  const del: string[] = [];
  for (const e of entries) {
    if (currentAppId && e.id === currentAppId) continue;
    if (e.heartbeatMtime != null && now - e.heartbeatMtime < reclaimMs) continue;
    del.push(e.id);
  }
  return del;
}

function mtimeOf(p: string): number | null {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}
function listDirs(parent: string): string[] {
  try {
    return fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/** Scan ~/.shelf/agent-server/* and ~/.shelf/apps/* and reclaim stale dirs. */
export function runCleanupSweep(currentVersion: string, currentAppId: string | undefined, now: number = Date.now()): void {
  try {
    const root = path.join(os.homedir(), '.shelf');
    const serverDir = path.join(root, 'agent-server');
    const versions: VersionEntry[] = listDirs(serverDir).map((name) => ({
      name,
      deployedMtime: mtimeOf(path.join(serverDir, name, '.deployed')),
      heartbeatMtime: mtimeOf(path.join(serverDir, name, '.heartbeat')),
    }));
    for (const name of planVersionSweep(versions, currentVersion, now)) {
      fs.rmSync(path.join(serverDir, name), { recursive: true, force: true });
    }
    const appsDir = path.join(root, 'apps');
    const apps: AppEntry[] = listDirs(appsDir).map((id) => ({
      id,
      heartbeatMtime: mtimeOf(path.join(appsDir, id, '.heartbeat')),
    }));
    for (const id of planAppsSweep(apps, currentAppId, now)) {
      fs.rmSync(path.join(appsDir, id), { recursive: true, force: true });
    }
  } catch { /* best-effort */ }
}
