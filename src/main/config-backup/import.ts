import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import {
  REPO_SKILLS_DIR,
  REPO_MCP_FILE,
  REPO_MACHINE_MANIFEST,
  SKILL_CONTROL_MARKERS,
  backupItemId,
  type BackupMachineManifest,
  type BackupSource,
  type ImportApplyResult,
  type ImportItemSummary,
  type ImportListResult,
} from '@shared/config-backup';
import { log } from '@shared/logger';
import { getAppInstanceId } from '../app-instance-id';
import { parseSkillMeta, skillDirPath } from '../skills-store';
import { validateMcpEntry, type McpServerBlock } from '@shared/mcp';
import { mcpConfigSourcePath } from '../mcp-projection';
import { onSkillsChanged } from '../skills-sync';
import { onMcpChanged } from '../mcp-sync';
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

/**
 * Import (copy) — READ side. Browse a chosen backup branch (another machine's or
 * my own) and list its items read-only from a pinned source commit. Shared
 * side-car work is serialized; writing into live is a later explicit step.
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
  if (pathExists(skillsDirectory)) {
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
  if (pathExists(mcpFile)) {
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

interface PreparedSkill {
  id: string;
  name: string;
  preparedDirectory: string;
  destination: string;
  changed: boolean;
}

interface PreparedMcp {
  changedIds: string[];
  nextBytes: Buffer | null;
  previousBytes: Buffer | null;
  destination: string;
}

interface PreparedImport {
  skills: PreparedSkill[];
  mcp: PreparedMcp;
}

interface AppliedSkill {
  item: PreparedSkill;
  displaced: string;
  hadDestination: boolean;
}

export interface ImportApplyDependencies {
  createSideCar(): SideCar;
  beforeCanonicalWrite?(itemId: string): void;
  beforeRollback?(itemId: string): void;
  notifySkillsChanged(): void;
  notifyMcpChanged(): void;
}

const DEFAULT_APPLY_DEPENDENCIES: ImportApplyDependencies = {
  createSideCar,
  notifySkillsChanged: onSkillsChanged,
  notifyMcpChanged: onMcpChanged,
};

function importFailure(
  phase: 'source' | 'validation' | 'apply' | 'rollback',
  message: string,
  rollback: 'not-needed' | 'completed' | 'failed',
  itemId?: string,
): ImportApplyResult {
  return { ok: false, phase, message, rollback, ...(itemId ? { itemId } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSelectedIds(selectedIds: string[]): {
  skills: Array<{ id: string; name: string }>;
  mcp: Array<{ id: string; name: string }>;
} | ImportApplyResult {
  const skills: Array<{ id: string; name: string }> = [];
  const mcp: Array<{ id: string; name: string }> = [];
  for (const id of [...new Set(selectedIds)]) {
    const parsed = parseId(id);
    if (!parsed || (parsed.kind !== 'skill' && parsed.kind !== 'mcp')) {
      return importFailure('validation', `Unknown Import item: ${id}`, 'not-needed', id);
    }
    (parsed.kind === 'skill' ? skills : mcp).push({ id, name: parsed.name });
  }
  if (skills.length === 0 && mcp.length === 0) {
    return importFailure('validation', 'Select at least one item to Import.', 'not-needed');
  }
  return { skills, mcp };
}

function copyValidatedSkill(
  sourceDirectory: string,
  destinationDirectory: string,
  name: string,
): string | null {
  const validation = validateSkillPayload(name, sourceDirectory);
  if (!validation.valid) return validation.reason;
  for (const relative of validation.payloadFiles) {
    const source = path.join(sourceDirectory, relative);
    const destination = path.join(destinationDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return null;
}

function preserveDestinationMarkers(destination: string, prepared: string): void {
  let destinationIsDirectory = false;
  try {
    const stat = fs.lstatSync(destination);
    destinationIsDirectory = !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!destinationIsDirectory) return;
  for (const marker of SKILL_CONTROL_MARKERS) {
    try {
      const stat = fs.lstatSync(path.join(destination, marker));
      if (stat.isFile() || stat.isSymbolicLink()) {
        fs.mkdirSync(prepared, { recursive: true });
        fs.writeFileSync(path.join(prepared, marker), '');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function treesEqual(left: string, right: string): boolean {
  let leftStat: fs.Stats;
  let rightStat: fs.Stats;
  try {
    leftStat = fs.lstatSync(left);
    rightStat = fs.lstatSync(right);
  } catch {
    return false;
  }
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return leftStat.isSymbolicLink()
      && rightStat.isSymbolicLink()
      && fs.readlinkSync(left) === fs.readlinkSync(right);
  }
  if (leftStat.isFile() || rightStat.isFile()) {
    return leftStat.isFile() && rightStat.isFile()
      && fs.readFileSync(left).equals(fs.readFileSync(right));
  }
  if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
  const leftEntries = fs.readdirSync(left).sort();
  const rightEntries = fs.readdirSync(right).sort();
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every((entry, index) => (
    entry === rightEntries[index]
    && treesEqual(path.join(left, entry), path.join(right, entry))
  ));
}

function pathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readKeyedMcpFile(file: string, label: string): {
  bytes: Buffer | null;
  servers: Record<string, unknown>;
} {
  if (!pathExists(file)) return { bytes: null, servers: Object.create(null) };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  const bytes = fs.readFileSync(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf-8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a keyed JSON object`);
  }
  return { bytes, servers: parsed as Record<string, unknown> };
}

function stableMcpBytes(servers: Record<string, unknown>): Buffer {
  const stable: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(servers).sort()) stable[name] = servers[name];
  return Buffer.from(JSON.stringify(stable, null, 2) + '\n', 'utf-8');
}

function prepareImport(
  sourceRoot: string,
  operationRoot: string,
  selected: Exclude<ReturnType<typeof parseSelectedIds>, ImportApplyResult>,
): PreparedImport | ImportApplyResult {
  const skills: PreparedSkill[] = [];
  try {
    for (const { id, name } of selected.skills) {
      const source = path.join(sourceRoot, REPO_SKILLS_DIR, name);
      const preparedDirectory = path.join(operationRoot, 'prepared', REPO_SKILLS_DIR, name);
      const validationError = copyValidatedSkill(source, preparedDirectory, name);
      if (validationError) {
        return importFailure('validation', `Cannot Import ${id}: ${validationError}`, 'not-needed', id);
      }
      const destination = skillDirPath(name);
      preserveDestinationMarkers(destination, preparedDirectory);
      const preparedValidation = validateSkillPayload(name, preparedDirectory);
      if (!preparedValidation.valid) {
        return importFailure(
          'validation',
          `Cannot Import ${id}: staged payload ${preparedValidation.reason}`,
          'not-needed',
          id,
        );
      }
      skills.push({
        id,
        name,
        preparedDirectory,
        destination,
        changed: !treesEqual(destination, preparedDirectory),
      });
    }

    const destination = mcpConfigSourcePath();
    if (selected.mcp.length === 0) {
      return {
        skills,
        mcp: { changedIds: [], nextBytes: null, previousBytes: null, destination },
      };
    }

    let sourceMcp: ReturnType<typeof readKeyedMcpFile>;
    let liveMcp: ReturnType<typeof readKeyedMcpFile>;
    try {
      sourceMcp = readKeyedMcpFile(path.join(sourceRoot, REPO_MCP_FILE), 'Source mcp-servers.json');
      liveMcp = readKeyedMcpFile(destination, 'Local mcp-servers.json');
    } catch (error) {
      return importFailure(
        'validation',
        `Cannot Import ${selected.mcp[0].id}: ${errorMessage(error)}`,
        'not-needed',
        selected.mcp[0].id,
      );
    }
    const next: Record<string, unknown> = Object.create(null);
    for (const [name, block] of Object.entries(liveMcp.servers)) next[name] = block;
    const changedIds: string[] = [];
    for (const { id, name } of selected.mcp) {
      if (!Object.prototype.hasOwnProperty.call(sourceMcp.servers, name)) {
        return importFailure('validation', `Import item ${id} is missing from the source`, 'not-needed', id);
      }
      const block = sourceMcp.servers[name];
      const validationError = validateMcpEntry(name, block);
      if (validationError) {
        return importFailure('validation', `Cannot Import ${id}: ${validationError}`, 'not-needed', id);
      }
      if (JSON.stringify(liveMcp.servers[name]) !== JSON.stringify(block)) changedIds.push(id);
      next[name] = structuredClone(block) as McpServerBlock;
    }
    return {
      skills,
      mcp: {
        changedIds,
        nextBytes: changedIds.length > 0 ? stableMcpBytes(next) : null,
        previousBytes: liveMcp.bytes,
        destination,
      },
    };
  } catch (error) {
    return importFailure('validation', `Could not prepare Import: ${errorMessage(error)}`, 'not-needed');
  }
}

function writeAtomic(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.import-${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function rollbackApplied(
  appliedSkills: AppliedSkill[],
  mcpAttempted: boolean,
  prepared: PreparedImport,
  dependencies: ImportApplyDependencies,
): { ok: true } | { ok: false; itemId?: string; messages: string[] } {
  const failures: Array<{ itemId?: string; message: string }> = [];
  if (mcpAttempted) {
    const itemId = prepared.mcp.changedIds[0];
    try {
      dependencies.beforeRollback?.(itemId ?? 'mcp');
      if (prepared.mcp.previousBytes === null) fs.rmSync(prepared.mcp.destination, { force: true });
      else writeAtomic(prepared.mcp.destination, prepared.mcp.previousBytes);
    } catch (error) {
      failures.push({ itemId, message: `MCP rollback failed: ${errorMessage(error)}` });
    }
  }
  for (const applied of [...appliedSkills].reverse()) {
    try {
      dependencies.beforeRollback?.(applied.item.id);
      fs.rmSync(applied.item.destination, { recursive: true, force: true });
      if (applied.hadDestination) fs.renameSync(applied.displaced, applied.item.destination);
    } catch (error) {
      failures.push({
        itemId: applied.item.id,
        message: `${applied.item.id} rollback failed: ${errorMessage(error)}`,
      });
    }
  }
  return failures.length === 0
    ? { ok: true }
    : { ok: false, itemId: failures[0].itemId, messages: failures.map((failure) => failure.message) };
}

function commitPreparedImport(
  prepared: PreparedImport,
  operationRoot: string,
  dependencies: ImportApplyDependencies,
): ImportApplyResult {
  const changedSkills = prepared.skills.filter((item) => item.changed);
  const appliedSkills: AppliedSkill[] = [];
  let mcpAttempted = false;
  let currentItemId: string | undefined;
  try {
    for (const item of changedSkills) {
      currentItemId = item.id;
      dependencies.beforeCanonicalWrite?.(item.id);
      const displaced = path.join(operationRoot, 'displaced', item.name);
      fs.mkdirSync(path.dirname(displaced), { recursive: true });
      const hadDestination = pathExists(item.destination);
      if (hadDestination) fs.renameSync(item.destination, displaced);
      const applied = { item, displaced, hadDestination };
      appliedSkills.push(applied);
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      fs.renameSync(item.preparedDirectory, item.destination);
    }

    if (prepared.mcp.nextBytes) {
      currentItemId = prepared.mcp.changedIds[0];
      dependencies.beforeCanonicalWrite?.(currentItemId);
      mcpAttempted = true;
      writeAtomic(prepared.mcp.destination, prepared.mcp.nextBytes);
    }
  } catch (error) {
    const rollback = rollbackApplied(appliedSkills, mcpAttempted, prepared, dependencies);
    if (!rollback.ok) {
      return importFailure(
        'rollback',
        `Import failed (${errorMessage(error)}); ${rollback.messages.join('; ')}`,
        'failed',
        rollback.itemId ?? currentItemId,
      );
    }
    return importFailure(
      'apply',
      `Could not apply ${currentItemId ?? 'Import'}: ${errorMessage(error)}`,
      appliedSkills.length > 0 || mcpAttempted ? 'completed' : 'not-needed',
      currentItemId,
    );
  }

  const itemsChanged = [
    ...changedSkills.map((item) => item.id),
    ...prepared.mcp.changedIds,
  ];
  return {
    ok: true,
    skillsWritten: changedSkills.length,
    mcpWritten: prepared.mcp.changedIds.length,
    itemsChanged,
  };
}

function cleanupOperationDirectory(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    log.warn('config-backup', `could not clean Import staging ${directory}: ${errorMessage(error)}`);
  }
}

/**
 * Import selected complete items from one pinned source revision. Preparation
 * validates and stages the whole batch before canonical mutation. Caught write
 * failures roll every already-applied item back while the process is running.
 */
export async function applyImport(
  remoteUrl: string,
  sourceRevision: string,
  selectedIds: string[],
  dependencies: ImportApplyDependencies = DEFAULT_APPLY_DEPENDENCIES,
): Promise<ImportApplyResult> {
  const selected = parseSelectedIds(selectedIds);
  if ('ok' in selected) return selected;

  return withConfigBackupOperation(async () => {
    const commit = resolveImportSource(remoteUrl, sourceRevision);
    if (!commit) {
      return importFailure(
        'source',
        'This Import source is no longer available. Find backups again.',
        'not-needed',
      );
    }

    let operationRoot: string;
    try {
      operationRoot = fs.mkdtempSync(path.join(app.getPath('userData'), '.config-backup-import-'));
    } catch (error) {
      return importFailure(
        'validation',
        `Could not create Import staging: ${errorMessage(error)}`,
        'not-needed',
      );
    }
    const sourceRoot = path.join(operationRoot, 'source');
    let cleaned = false;
    try {
      try {
        const sideCar = dependencies.createSideCar();
        await sideCar.ensureClone(remoteUrl);
        await sideCar.exportCommit(commit, sourceRoot);
      } catch (error) {
        return importFailure('source', `Could not load Import source: ${errorMessage(error)}`, 'not-needed');
      }

      const prepared = prepareImport(sourceRoot, operationRoot, selected);
      if ('ok' in prepared) return prepared;
      const result = commitPreparedImport(prepared, operationRoot, dependencies);
      if (!result.ok) return result;

      cleanupOperationDirectory(operationRoot);
      cleaned = true;
      if (result.skillsWritten > 0) {
        try {
          dependencies.notifySkillsChanged();
        } catch (error) {
          log.error('config-backup', `post-Import Skills projection failed: ${errorMessage(error)}`);
        }
      }
      if (result.mcpWritten > 0) {
        try {
          dependencies.notifyMcpChanged();
        } catch (error) {
          log.error('config-backup', `post-Import MCP projection failed: ${errorMessage(error)}`);
        }
      }
      log.info(
        'config-backup',
        `import applied: ${result.skillsWritten} Skill(s), ${result.mcpWritten} MCP server(s)`,
      );
      return result;
    } finally {
      if (!cleaned) cleanupOperationDirectory(operationRoot);
    }
  });
}
