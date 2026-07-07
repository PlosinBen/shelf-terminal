import fs from 'fs';
import path from 'path';
import {
  REPO_SKILLS_DIR,
  REPO_MCP_FILE,
  REPO_MACHINE_MANIFEST,
  backupItemId,
  type BackupItemSummary,
  type BackupItemKind,
  type BackupMachineManifest,
  type ImportEntry,
  type ImportItemPlan,
} from '@shared/config-backup';
import { log } from '@shared/logger';
import { getAppInstanceId } from '../app-instance-id';
import { parseSkillMeta, skillDirPath } from '../skills-store';
import { listMcpServers } from '../mcp-store';
import { loadBinding } from './binding-store';
import { createSideCar, type SideCar } from './side-car';

/** Split `kind:name` into a kind + name (names carry no colon). */
function parseId(id: string): { kind: string; name: string } | null {
  const idx = id.indexOf(':');
  if (idx < 0) return null;
  const name = id.slice(idx + 1);
  if (!name) return null;
  return { kind: id.slice(0, idx), name };
}

const hasNul = (s: string) => s.includes('\u0000');

/**
 * Import (copy) — READ side. Browse a chosen backup branch (another machine's or
 * my own) and list its items, entirely read-only against the source branch (zero
 * contention). Writing into live is a later step; nothing here touches live.
 */

export interface BackupSource {
  /** Readable git ref, e.g. `origin/backup/<id>`. */
  ref: string;
  branch: string;
  appInstanceId: string;
  /** Human label from the branch's machine.json (falls back to the id). */
  machineLabel: string;
  /** True for this machine's own branch (self-restore). */
  isSelf: boolean;
}

/** Unique skill folder names present under `skills/` at a ref. */
function skillNamesFromFiles(files: string[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    if (f.startsWith(REPO_SKILLS_DIR + '/')) {
      const name = f.slice(REPO_SKILLS_DIR.length + 1).split('/')[0];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** Fetch + list every backup branch (all machines, incl. this one). */
export async function listBackupSources(): Promise<BackupSource[]> {
  const binding = loadBinding();
  if (!binding) return [];

  const sideCar = createSideCar();
  await sideCar.ensureClone(binding.remoteUrl);
  await sideCar.fetch();

  const selfId = getAppInstanceId();
  const branches = await sideCar.listBackupBranches();
  const out: BackupSource[] = [];
  for (const b of branches) {
    let machineLabel = b.appInstanceId;
    const raw = await sideCar.readFileAtRef(b.ref, REPO_MACHINE_MANIFEST);
    if (raw) {
      try {
        const m = JSON.parse(raw) as BackupMachineManifest;
        if (m?.machineLabel) machineLabel = m.machineLabel;
      } catch {
        log.warn('config-backup', `branch ${b.branch} has an unreadable machine.json — using id as label`);
      }
    }
    out.push({
      ref: b.ref,
      branch: b.branch,
      appInstanceId: b.appInstanceId,
      machineLabel,
      isSelf: b.appInstanceId === selfId,
    });
  }
  // Own branch first, then by label.
  out.sort((a, b) => (a.isSelf === b.isSelf ? a.machineLabel.localeCompare(b.machineLabel) : a.isSelf ? -1 : 1));
  return out;
}

/** List the backup-able items present in a chosen branch (read-only). */
export async function listImportItems(ref: string, sideCar: SideCar = createSideCar()): Promise<BackupItemSummary[]> {
  const files = await sideCar.listFilesAtRef(ref);
  const out: BackupItemSummary[] = [];

  for (const name of skillNamesFromFiles(files)) {
    let detail: string | undefined;
    const raw = await sideCar.readFileAtRef(ref, `${REPO_SKILLS_DIR}/${name}/SKILL.md`);
    if (raw) detail = parseSkillMeta(raw).description;
    out.push({ id: backupItemId('skill', name), kind: 'skill', name, ...(detail ? { detail } : {}) });
  }

  const mcpRaw = await sideCar.readFileAtRef(ref, REPO_MCP_FILE);
  if (mcpRaw) {
    try {
      const servers = JSON.parse(mcpRaw) as Record<string, { type?: string }>;
      for (const name of Object.keys(servers).sort()) {
        out.push({ id: backupItemId('mcp', name), kind: 'mcp', name, detail: servers[name]?.type });
      }
    } catch {
      log.warn('config-backup', `branch mcp-servers.json at ${ref} is not valid JSON — skipped in import list`);
    }
  }

  return out;
}

// ── Import plan: per-item overwrite status vs live (NOT a conflict — just an
//    honest "you already have this; here's what changes; replace or keep") ────

/** Per-file status of a backup skill vs live. Live-only files are ignored
 *  (Import never deletes — no-orphan invariant `skills#8`). */
async function planSkill(ref: string, name: string, sideCar: SideCar): Promise<ImportEntry[]> {
  const prefix = `${REPO_SKILLS_DIR}/${name}/`;
  const files = (await sideCar.listFilesAtRef(ref)).filter((f) => f.startsWith(prefix));
  const liveDir = skillDirPath(name);
  const entries: ImportEntry[] = [];
  for (const f of files) {
    const rel = f.slice(prefix.length);
    const backup = (await sideCar.readFileAtRef(ref, f)) ?? '';
    const liveFile = path.join(liveDir, rel);
    if (!fs.existsSync(liveFile)) {
      entries.push({ path: rel, change: 'new' });
      continue;
    }
    const live = fs.readFileSync(liveFile, 'utf-8');
    if (live === backup) {
      entries.push({ path: rel, change: 'identical' });
      continue;
    }
    const binary = hasNul(backup) || hasNul(live);
    entries.push({ path: rel, change: 'differs', ...(binary ? { binary: true } : { live, backup }) });
  }
  return entries;
}

/** Status of a backup MCP server block vs live (per-server, never whole-file). */
async function planMcp(ref: string, name: string, sideCar: SideCar): Promise<ImportEntry[]> {
  const raw = await sideCar.readFileAtRef(ref, REPO_MCP_FILE);
  if (!raw) return [];
  let servers: Record<string, unknown>;
  try {
    servers = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!(name in servers)) return [];
  const backup = JSON.stringify(servers[name], null, 2);
  const liveAll = listMcpServers();
  if (!(name in liveAll)) return [{ path: '', change: 'new' }];
  const live = JSON.stringify(liveAll[name], null, 2);
  if (live === backup) return [{ path: '', change: 'identical' }];
  return [{ path: '', change: 'differs', live, backup }];
}

/**
 * Compute the per-item import plan for a chosen branch + selected items: for each
 * item, the file/block-level status (new / identical / differs) and whether it
 * conflicts (any differs → needs a replace/keep confirm). Read-only; the caller
 * must have fetched (via listBackupSources). Items absent from the branch drop.
 */
export async function planImport(
  ref: string,
  selectedIds: string[],
  sideCar: SideCar = createSideCar(),
): Promise<ImportItemPlan[]> {
  const out: ImportItemPlan[] = [];
  for (const id of selectedIds) {
    const parsed = parseId(id);
    if (!parsed) continue;
    let entries: ImportEntry[] = [];
    if (parsed.kind === 'skill') entries = await planSkill(ref, parsed.name, sideCar);
    else if (parsed.kind === 'mcp') entries = await planMcp(ref, parsed.name, sideCar);
    else continue;
    if (entries.length === 0) continue; // not present in this branch
    out.push({
      id,
      kind: parsed.kind as BackupItemKind,
      name: parsed.name,
      entries,
      hasConflict: entries.some((e) => e.change === 'differs'),
    });
  }
  return out;
}
