import path from 'path';
import fs from 'fs';
import { log } from '@shared/logger';
import {
  REPO_SKILLS_DIR,
  REPO_MCP_FILE,
  REPO_MACHINE_MANIFEST,
  backupItemId,
  type BackupMachineManifest,
} from '@shared/config-backup';
import type { McpServersFile } from '@shared/mcp';
import { getAppInstanceId } from '../app-instance-id';
import { skillDirPath } from '../skills-store';
import { listMcpServers } from '../mcp-store';
import { loadBinding, thisMachineBranchRef } from './binding-store';
import { createSideCar } from './side-car';
import { preflight } from './preflight';

/**
 * Backup (Publish): snapshot the ticked live items → this machine's branch →
 * push. One-way (live → my branch); NEVER touches live. Per-item selection is
 * the leak gate — an unticked item never leaves the machine.
 *
 * Snapshot semantics: each Backup writes EXACTLY the ticked set. The payload
 * region of the working tree is cleared and re-copied, so `git add -A` stages
 * removals for items that were backed up before but are no longer ticked — the
 * branch is always "my latest published set" (current-state-wins). Because only
 * this machine writes its own branch, the push is a fast-forward.
 */

export type BackupRunResult =
  | { ok: true; pushed: boolean; branch: string; itemCount: number }
  | { ok: false; reason: 'not-bound' | 'no-git' | 'remote'; message: string };

interface Selection {
  skills: string[];
  mcp: string[];
}

/** Split `kind:name` ids into skill / mcp buckets (names carry no colon). */
function parseSelection(selectedIds: string[]): Selection {
  const skills: string[] = [];
  const mcp: string[] = [];
  for (const id of selectedIds) {
    const idx = id.indexOf(':');
    if (idx < 0) continue;
    const kind = id.slice(0, idx);
    const name = id.slice(idx + 1);
    if (!name) continue;
    if (kind === 'skill') skills.push(name);
    else if (kind === 'mcp') mcp.push(name);
  }
  return { skills, mcp };
}

/** Rewrite the working tree's payload region to exactly the ticked set. */
function writeSnapshot(repoDir: string, sel: Selection): number {
  let count = 0;

  // Skills — clear the whole dir, then copy each ticked folder verbatim.
  const repoSkills = path.join(repoDir, REPO_SKILLS_DIR);
  fs.rmSync(repoSkills, { recursive: true, force: true });
  for (const name of sel.skills) {
    const src = skillDirPath(name);
    if (!fs.existsSync(src)) {
      log.warn('config-backup', `ticked skill "${name}" not found on disk — skipped`);
      continue;
    }
    fs.cpSync(src, path.join(repoSkills, name), { recursive: true });
    count++;
  }

  // MCP — one keyed-object file with only the ticked servers (verbatim blocks).
  const repoMcp = path.join(repoDir, REPO_MCP_FILE);
  fs.rmSync(repoMcp, { force: true });
  if (sel.mcp.length > 0) {
    const all = listMcpServers();
    const picked: McpServersFile = {};
    for (const name of sel.mcp.sort()) {
      if (name in all) {
        picked[name] = all[name];
        count++;
      } else {
        log.warn('config-backup', `ticked MCP server "${name}" not found — skipped`);
      }
    }
    if (Object.keys(picked).length > 0) {
      fs.writeFileSync(repoMcp, JSON.stringify(picked, null, 2) + '\n', 'utf-8');
    }
  }

  return count;
}

/** Always-present branch manifest so the Import picker can show a human label. */
function writeManifest(repoDir: string, machineLabel: string): void {
  const manifest: BackupMachineManifest = { appInstanceId: getAppInstanceId(), machineLabel };
  fs.writeFileSync(
    path.join(repoDir, REPO_MACHINE_MANIFEST),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
}

export async function runBackup(selectedIds: string[]): Promise<BackupRunResult> {
  const binding = loadBinding();
  if (!binding) {
    return { ok: false, reason: 'not-bound', message: 'This machine is not bound to a backup remote yet.' };
  }

  const pf = await preflight(binding.remoteUrl);
  if (!pf.ok) return { ok: false, reason: pf.reason, message: pf.message };

  const sel = parseSelection(selectedIds);
  const branch = thisMachineBranchRef();
  const sideCar = createSideCar();

  await sideCar.ensureClone(binding.remoteUrl);
  await sideCar.fetch();
  await sideCar.checkoutBranch(branch);

  const itemCount = writeSnapshot(sideCar.dir, sel);
  writeManifest(sideCar.dir, binding.machineLabel);

  const stamp = `backup: ${sel.skills.length} skill(s), ${sel.mcp.length} mcp server(s)`;
  const changed = await sideCar.stageAllAndCommit(stamp);
  if (changed) {
    await sideCar.push(branch);
    log.info('config-backup', `pushed ${branch} (${itemCount} item(s))`);
  } else {
    log.info('config-backup', `${branch} already up to date — nothing to push`);
  }

  return { ok: true, pushed: changed, branch, itemCount };
}

/**
 * Item ids already present in THIS machine's backup branch. Used to pre-tick the
 * Backup checklist: because a Backup writes a full snapshot (unticking removes),
 * defaulting existing items to ticked prevents accidentally dropping them, while
 * new/never-backed-up items stay unticked (the leak gate).
 *
 * Best-effort: throws only if the remote can't be reached (caller decides how to
 * degrade); an as-yet-unpushed branch simply yields [].
 */
export async function readBackedUpItemIds(): Promise<string[]> {
  const binding = loadBinding();
  if (!binding) return [];

  const sideCar = createSideCar();
  await sideCar.ensureClone(binding.remoteUrl);
  await sideCar.fetch();
  const ref = `origin/${thisMachineBranchRef()}`;

  let files: string[];
  try {
    files = await sideCar.listFilesAtRef(ref);
  } catch {
    return []; // branch not pushed yet
  }

  const ids = new Set<string>();
  for (const f of files) {
    if (f.startsWith(REPO_SKILLS_DIR + '/')) {
      const name = f.slice(REPO_SKILLS_DIR.length + 1).split('/')[0];
      if (name) ids.add(backupItemId('skill', name));
    }
  }
  const mcpRaw = await sideCar.readFileAtRef(ref, REPO_MCP_FILE);
  if (mcpRaw) {
    try {
      for (const name of Object.keys(JSON.parse(mcpRaw))) ids.add(backupItemId('mcp', name));
    } catch {
      log.warn('config-backup', 'backup branch mcp-servers.json is not valid JSON — ignoring for defaults');
    }
  }
  return [...ids];
}
