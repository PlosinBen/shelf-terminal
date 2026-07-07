import {
  REPO_SKILLS_DIR,
  REPO_MCP_FILE,
  REPO_MACHINE_MANIFEST,
  backupItemId,
  type BackupItemSummary,
  type BackupMachineManifest,
} from '@shared/config-backup';
import { log } from '@shared/logger';
import { getAppInstanceId } from '../app-instance-id';
import { parseSkillMeta } from '../skills-store';
import { loadBinding } from './binding-store';
import { createSideCar, type SideCar } from './side-car';

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
