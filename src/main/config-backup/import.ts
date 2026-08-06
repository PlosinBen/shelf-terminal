import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  REPO_SKILLS_DIR,
  REPO_MCP_FILE,
  REPO_MACHINE_MANIFEST,
  backupItemId,
  type BackupItemKind,
  type BackupMachineManifest,
  type ImportEntry,
  type ImportItemPlan,
  type ImportDecision,
  type BackupSource,
  type ImportApplyResult,
  type ImportItemSummary,
  type ImportListResult,
} from '@shared/config-backup';
import { log } from '@shared/logger';
import { getAppInstanceId } from '../app-instance-id';
import { parseSkillMeta, skillDirPath } from '../skills-store';
import { listMcpServers, addMcpServer, updateMcpServer } from '../mcp-store';
import { validateMcpEntry } from '@shared/mcp';
import { onSkillsChanged } from '../skills-sync';
import { onMcpChanged } from '../mcp-sync';
import type { McpServerBlock } from '@shared/mcp';
import { enumerateLiveItems } from './enumerate';
import { withConfigBackupOperation } from './operation-lock';
import { createSideCar, type SideCar } from './side-car';
import { pinImportSource, resolveImportSource } from './source-revisions';
import { validateSkillPayload } from './validation';

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

/** Fetch + list every backup branch (all machines, incl. this one). */
export async function listBackupSources(remoteUrl: string): Promise<BackupSource[]> {
  if (!remoteUrl) return [];
  return withConfigBackupOperation(async () => {
    const sideCar = createSideCar();
    await sideCar.ensureClone(remoteUrl);
    await sideCar.fetch();

    const selfId = getAppInstanceId();
    const branches = await sideCar.listBackupBranches();
    const out: BackupSource[] = [];
    for (const branch of branches) {
      let machineLabel = branch.appInstanceId;
      const raw = await sideCar.readFileAtRef(branch.ref, REPO_MACHINE_MANIFEST);
      if (raw) {
        try {
          const manifest = JSON.parse(raw) as BackupMachineManifest;
          if (manifest?.machineLabel) machineLabel = manifest.machineLabel;
        } catch {
          log.warn('config-backup', `branch ${branch.branch} has an unreadable machine.json — using id as label`);
        }
      }
      const commit = await sideCar.resolveCommit(branch.ref);
      out.push({
        branch: branch.branch,
        appInstanceId: branch.appInstanceId,
        machineLabel,
        isSelf: branch.appInstanceId === selfId,
        sourceRevision: pinImportSource(remoteUrl, commit),
      });
    }
    out.sort((a, b) => (
      a.isSelf === b.isSelf
        ? a.machineLabel.localeCompare(b.machineLabel)
        : a.isSelf ? -1 : 1
    ));
    return out;
  });
}

function inspectImportItems(directory: string, liveIds: Set<string>): ImportListResult {
  const items: ImportItemSummary[] = [];
  const issues: ImportListResult['issues'] = [];
  const impact = (id: string) => liveIds.has(id) ? 'replace-local' as const : 'new' as const;

  const skillsDirectory = path.join(directory, REPO_SKILLS_DIR);
  if (fs.existsSync(skillsDirectory)) {
    const skillsStat = fs.lstatSync(skillsDirectory);
    if (skillsStat.isSymbolicLink() || !skillsStat.isDirectory()) {
      throw new Error('Source skills path must be a regular directory.');
    }
    for (const entry of fs.readdirSync(skillsDirectory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const id = backupItemId('skill', entry.name);
      const validation = validateSkillPayload(entry.name, path.join(skillsDirectory, entry.name));
      if (!validation.valid) {
        items.push({
          id,
          kind: 'skill',
          name: entry.name,
          valid: false,
          invalidReason: validation.reason,
          impact: impact(id),
        });
        continue;
      }
      const skillMarkdown = fs.readFileSync(path.join(skillsDirectory, entry.name, 'SKILL.md'), 'utf-8');
      const detail = parseSkillMeta(skillMarkdown).description;
      items.push({
        id,
        kind: 'skill',
        name: entry.name,
        ...(detail ? { detail } : {}),
        valid: true,
        impact: impact(id),
      });
    }
  }

  const mcpFile = path.join(directory, REPO_MCP_FILE);
  if (fs.existsSync(mcpFile)) {
    const stat = fs.lstatSync(mcpFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      issues.push({ scope: 'mcp', message: 'mcp-servers.json must be a regular file.' });
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        issues.push({ scope: 'mcp', message: 'mcp-servers.json is not a keyed JSON object.' });
      } else {
        for (const [name, block] of Object.entries(parsed as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))) {
          const id = backupItemId('mcp', name);
          const error = validateMcpEntry(name, block);
          items.push(error
            ? { id, kind: 'mcp', name, valid: false, invalidReason: error, impact: impact(id) }
            : {
                id,
                kind: 'mcp',
                name,
                detail: (block as { type: string }).type,
                valid: true,
                impact: impact(id),
              });
        }
      }
    }
  }

  return { items, issues };
}

/** Materialize and inspect a pinned source without touching the side-car tree/index. */
export async function listImportItems(
  remoteUrl: string,
  sourceRevision: string,
): Promise<ImportListResult> {
  return withConfigBackupOperation(async () => {
    const commit = resolveImportSource(remoteUrl, sourceRevision);
    if (!commit) throw new Error('This Import source is no longer available. Find backups again.');

    const sideCar = createSideCar();
    await sideCar.ensureClone(remoteUrl);
    const operationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-import-source-'));
    try {
      await sideCar.exportCommit(commit, operationDirectory);
      const liveIds = new Set((await enumerateLiveItems()).map((item) => item.id));
      return inspectImportItems(operationDirectory, liveIds);
    } finally {
      fs.rmSync(operationDirectory, { recursive: true, force: true });
    }
  });
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

// ── Apply: the ONLY writer of live. Per item: new files always copied, identical
//    skipped, differing files copied iff replaceConflicts. Never deletes. ──────

/** Recursively list file paths under `dir`, relative to it. */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out;
}

function bytesEqual(a: string, b: string): boolean {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Copy a backup skill's files into live (binary-safe). Returns files written. */
async function applySkill(ref: string, name: string, replace: boolean, sideCar: SideCar): Promise<number> {
  const repoRel = `${REPO_SKILLS_DIR}/${name}`;
  await sideCar.checkoutPathsFromRef(ref, [repoRel]); // materialize real bytes
  const srcDir = path.join(sideCar.dir, repoRel);
  if (!fs.existsSync(srcDir)) return 0;
  const liveDir = skillDirPath(name);
  let written = 0;
  for (const rel of walkFiles(srcDir)) {
    const src = path.join(srcDir, rel);
    const dest = path.join(liveDir, rel);
    if (!fs.existsSync(dest)) {
      copyFile(src, dest); // new file — additive
      written++;
    } else if (bytesEqual(src, dest)) {
      // identical — skip
    } else if (replace) {
      copyFile(src, dest); // differs + replace
      written++;
    }
    // differs + keep → leave live untouched
  }
  return written;
}

/** Merge one backup MCP server block into live (per-server, never whole-file). */
async function applyMcp(ref: string, name: string, replace: boolean, sideCar: SideCar): Promise<boolean> {
  const raw = await sideCar.readFileAtRef(ref, REPO_MCP_FILE);
  if (!raw) return false;
  let servers: Record<string, unknown>;
  try {
    servers = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!(name in servers)) return false;
  const block = servers[name] as McpServerBlock;
  const live = listMcpServers();
  if (!(name in live)) {
    return addMcpServer(name, block).ok;
  }
  if (JSON.stringify(live[name]) === JSON.stringify(block)) return false; // identical
  if (!replace) return false; // keep live
  return updateMcpServer(name, block).ok;
}

/**
 * Apply an import into live — the ONLY writer of live config. For each decision:
 * new files/servers are always copied (additive), identical skipped, and
 * differing ones overwritten only when replaceConflicts is set. Live-only skill
 * files are never removed (no-orphan `skills#8`). Writes route through the normal
 * re-projection pipelines (onSkillsChanged / onMcpChanged).
 */
export async function applyImport(
  ref: string,
  decisions: ImportDecision[],
  sideCar: SideCar = createSideCar(),
): Promise<ImportApplyResult> {
  let skillsWritten = 0;
  let mcpWritten = 0;
  const itemsChanged: string[] = [];
  let anySkill = false;
  let anyMcp = false;

  for (const { id, replaceConflicts } of decisions) {
    const parsed = parseId(id);
    if (!parsed) continue;
    if (parsed.kind === 'skill') {
      const n = await applySkill(ref, parsed.name, replaceConflicts, sideCar);
      if (n > 0) {
        skillsWritten += n;
        itemsChanged.push(id);
        anySkill = true;
      }
    } else if (parsed.kind === 'mcp') {
      const wrote = await applyMcp(ref, parsed.name, replaceConflicts, sideCar);
      if (wrote) {
        mcpWritten++;
        itemsChanged.push(id);
        anyMcp = true;
      }
    }
  }

  if (anySkill) onSkillsChanged();
  if (anyMcp) onMcpChanged();
  log.info('config-backup', `import applied: ${skillsWritten} skill file(s), ${mcpWritten} mcp server(s)`);
  return { ok: true, skillsWritten, mcpWritten, itemsChanged };
}
