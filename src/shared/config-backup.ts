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
 * side-car in src/main/config-backup/.
 */

/** Machine-local binding file under `<userData>` — never part of any backup payload. */
export const CONFIG_BACKUP_FILE = 'config-backup.json';

/** Machine-local backup-intent file under `<userData>` — the item ids this machine
 *  last chose to back up (drives the checklist pre-tick). Local prefs, never backed up. */
export const CONFIG_BACKUP_INTENT_FILE = 'config-backup-intent.json';

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

/**
 * Turn a raw hostname (or any string) into a tidy machine label: keep letters,
 * digits, `.`, `_`, `-`; replace every other character with `-`. Deliberately
 * does NOT strip a domain suffix — `Ben's MBP.local` → `Ben-s-MBP.local`.
 * The label is display-only (branch id is the app-instance-id), so this is
 * cosmetic, not a validity constraint.
 */
export function sanitizeMachineLabel(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '-');
}

// ── Payload layout inside a backup branch's working tree ────────────────────
// Single source of truth for both Backup (copy in) and Import (read out).

/** Skills live under `<repo>/skills/<name>/…` (mirrors the live folder shape). */
export const REPO_SKILLS_DIR = 'skills';
/** MCP servers are one keyed-object JSON at the repo root. */
export const REPO_MCP_FILE = 'mcp-servers.json';
/** Per-branch manifest so the Import picker can show a human machine label. */
export const REPO_MACHINE_MANIFEST = 'machine.json';

/** Shelf-local Skill controls are not portable Skill payload. */
export const SKILL_CONTROL_MARKERS = ['.locked', '.disabled'] as const;

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

interface BackupItemSummaryBase {
  id: string;
  kind: BackupItemKind;
  name: string;
  /** Skill description / MCP transport type — a one-line hint for the checklist. */
  detail?: string;
}

export type BackupItemSummary = BackupItemSummaryBase & (
  | { valid: true }
  | { valid: false; invalidReason: string }
);

/** A backup branch available to import from (all machines, incl. own). */
export interface BackupSource {
  branch: string;
  appInstanceId: string;
  /** Human label from the branch's machine.json (falls back to the id). */
  machineLabel: string;
  /** True for this machine's own branch (self-restore). */
  isSelf: boolean;
  /** Opaque process-local handle pinned to the fetched branch commit. */
  sourceRevision: string;
}

export type ImportItemImpact = 'new' | 'replace-local';

export type ImportItemSummary = BackupItemSummary & {
  impact: ImportItemImpact;
};

export interface ImportListIssue {
  scope: 'mcp';
  message: string;
}

export interface ImportListResult {
  items: ImportItemSummary[];
  issues: ImportListIssue[];
}

export type ImportFailurePhase = 'source' | 'validation' | 'apply' | 'rollback';
export type ImportRollbackResult = 'not-needed' | 'completed' | 'failed';

export type ImportApplyResult =
  | {
      ok: true;
      /** Number of selected Skill items whose canonical bytes changed. */
      skillsWritten: number;
      /** Number of selected MCP blocks whose canonical value changed. */
      mcpWritten: number;
      /** Selected ids that changed canonical live state. */
      itemsChanged: string[];
    }
  | {
      ok: false;
      phase: ImportFailurePhase;
      itemId?: string;
      message: string;
      rollback: ImportRollbackResult;
    };

/** Response for the Backup tab: saved remote settings + live items + pre-tick. */
export interface BackupListResult {
  binding: ConfigBackupBinding | null;
  items: BackupItemSummary[];
  /** Item ids this machine last chose to back up → default-ticked. Read from
   *  machine-local intent (no remote/network); new items start unticked. */
  intent: string[];
  /** Default label for a machine that hasn't set one yet (sanitized hostname). */
  suggestedLabel: string;
}

export type BackupRunResult =
  | { ok: true; pushed: boolean; branch: string; itemCount: number }
  | {
      ok: false;
      reason: 'not-bound' | 'validation' | 'remote';
      message: string;
      itemId?: string;
    };
