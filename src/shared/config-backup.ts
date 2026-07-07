/**
 * App-Level Config Backup & Copy — shared constants + types.
 *
 * Model (see the feature design): this is BACKUP + cross-machine COPY, NOT sync.
 * - Each machine owns ONE branch (its backup) on a shared remote. Because only
 *   that machine ever writes its own branch, every push is fast-forward — no
 *   merge, no conflict engine.
 * - A machine's live config is its SOLE source of truth; nothing auto-overwrites
 *   it. Two actions only: Backup (live → my branch) and Import (a chosen branch →
 *   live, per-item, overwrite-confirmed).
 *
 * git engine = the machine's own `git` (via simple-git); auth = the machine's
 * existing git credentials (Shelf holds no secret). See binding-store /
 * side-car / preflight in src/main/config-backup/.
 */

/** Machine-local binding file under `<userData>` — never part of any backup payload. */
export const CONFIG_BACKUP_FILE = 'config-backup.json';

/** Per-machine backup branches share this ref prefix (ref keyed by app-instance-id). */
export const BACKUP_BRANCH_PREFIX = 'backup/';

/**
 * A machine's backup branch ref, derived deterministically from its stable
 * per-install `app-instance-id`. Opaque but valid as a git ref; the human label
 * for display lives in the binding + travels with the branch manifest.
 */
export function backupBranchRef(appInstanceId: string): string {
  return `${BACKUP_BRANCH_PREFIX}${appInstanceId}`;
}

/**
 * Machine-local binding: which remote this machine backs up to, and the
 * user-facing label for this machine's branch. `remoteUrl` is whatever the
 * user's git can push to (https or ssh) — Shelf never parses or authenticates
 * it; the machine's git credentials do.
 */
export interface ConfigBackupBinding {
  remoteUrl: string;
  machineLabel: string;
}

// ── Payload layout inside a backup branch's working tree ────────────────────
// Single source of truth for both Backup (copy in) and Import (read out).

/** Skills live under `<repo>/skills/<name>/…` (mirrors the live folder shape). */
export const REPO_SKILLS_DIR = 'skills';
/** MCP servers are one keyed-object JSON at the repo root. */
export const REPO_MCP_FILE = 'mcp-servers.json';
/** Per-branch manifest so the Import picker can show a human machine label. */
export const REPO_MACHINE_MANIFEST = 'machine.json';

/** Written at the root of each machine's branch; read by the Import source picker. */
export interface BackupMachineManifest {
  appInstanceId: string;
  machineLabel: string;
}

// ── Enumerated backup-able items (the per-item checklist unit) ───────────────

export type BackupItemKind = 'skill' | 'mcp';

/** Stable per-item id used by the checklist + IPC selection. */
export function backupItemId(kind: BackupItemKind, name: string): string {
  return `${kind}:${name}`;
}

export interface BackupItemSummary {
  id: string;
  kind: BackupItemKind;
  name: string;
  /** Skill description / MCP transport type — a one-line hint for the checklist. */
  detail?: string;
}
