import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from '@shared/logger';
import {
  REPO_MACHINE_MANIFEST,
  REPO_MCP_FILE,
  REPO_SKILLS_DIR,
  type BackupItemSummary,
  type BackupMachineManifest,
  type BackupRunResult,
} from '@shared/config-backup';
import type { McpServerBlock, McpServersFile } from '@shared/mcp';
import { getAppInstanceId } from '../app-instance-id';
import { listMcpServers } from '../mcp-store';
import { skillDirPath } from '../skills-store';
import { loadBinding, thisMachineBranchRef } from './binding-store';
import { enumerateLiveItems } from './enumerate';
import { saveIntent } from './intent-store';
import { createSideCar, type SideCar } from './side-car';
import { validateSkillPayload } from './validation';
import { withConfigBackupOperation } from './operation-lock';

interface BackupSnapshot {
  directory: string;
  selected: BackupItemSummary[];
  mcp: McpServersFile;
}

interface BackupDependencies {
  enumerateLiveItems(): Promise<BackupItemSummary[]>;
  createSideCar(): SideCar;
}

const DEFAULT_DEPENDENCIES: BackupDependencies = {
  enumerateLiveItems,
  createSideCar,
};

function validationFailure(message: string, itemId?: string): BackupRunResult {
  return { ok: false, reason: 'validation', message, ...(itemId ? { itemId } : {}) };
}

function copyValidatedSkill(
  name: string,
  destination: string,
): BackupRunResult | null {
  const itemId = `skill:${name}`;
  const source = skillDirPath(name);
  const validation = validateSkillPayload(name, source);
  if (!validation.valid) {
    return validationFailure(`Cannot back up ${itemId}: ${validation.reason}`, itemId);
  }

  try {
    for (const relative of validation.payloadFiles) {
      const sourceFile = path.join(source, relative);
      const stat = fs.lstatSync(sourceFile);
      if (!stat.isFile()) {
        return validationFailure(`Cannot back up ${itemId}: ${relative} changed while being captured`, itemId);
      }
      const destinationFile = path.join(destination, relative);
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
      fs.copyFileSync(sourceFile, destinationFile);
    }
  } catch (error) {
    return validationFailure(
      `Cannot back up ${itemId}: ${error instanceof Error ? error.message : String(error)}`,
      itemId,
    );
  }

  const capturedValidation = validateSkillPayload(name, destination);
  if (!capturedValidation.valid) {
    return validationFailure(`Cannot back up ${itemId}: ${capturedValidation.reason}`, itemId);
  }
  return null;
}

async function captureSelected(
  selectedIds: string[],
  dependencies: BackupDependencies,
): Promise<BackupSnapshot | BackupRunResult> {
  let available: BackupItemSummary[];
  try {
    available = await dependencies.enumerateLiveItems();
  } catch (error) {
    return validationFailure(
      `Could not refresh Backup items: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const byId = new Map(available.map((item) => [item.id, item]));
  const selected: BackupItemSummary[] = [];
  for (const id of selectedIds) {
    const item = byId.get(id);
    if (!item) return validationFailure(`Backup item "${id}" no longer exists`, id);
    if (!item.valid) return validationFailure(`Cannot back up ${id}: ${item.invalidReason}`, id);
    selected.push(item);
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-backup-capture-'));
  const mcp: McpServersFile = {};
  try {
    const liveMcp = selected.some((item) => item.kind === 'mcp') ? listMcpServers() : {};
    for (const item of selected) {
      if (item.kind === 'skill') {
        const failure = copyValidatedSkill(
          item.name,
          path.join(directory, REPO_SKILLS_DIR, item.name),
        );
        if (failure) {
          fs.rmSync(directory, { recursive: true, force: true });
          return failure;
        }
      } else {
        const block = liveMcp[item.name];
        if (!block) {
          fs.rmSync(directory, { recursive: true, force: true });
          return validationFailure(`Backup item "${item.id}" no longer exists`, item.id);
        }
        mcp[item.name] = structuredClone(block);
      }
    }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    return validationFailure(
      `Could not capture Backup items: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { directory, selected, mcp };
}

function readRemoteMcp(repoDirectory: string): Record<string, unknown> {
  const file = path.join(repoDirectory, REPO_MCP_FILE);
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new Error('Remote mcp-servers.json is not valid JSON; nothing was pushed.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Remote mcp-servers.json is not a keyed object; nothing was pushed.');
  }
  return parsed as Record<string, unknown>;
}

function applySelected(
  repoDirectory: string,
  snapshot: BackupSnapshot,
  machineLabel: string,
): string[] {
  const selectedMcp = snapshot.selected.filter((item) => item.kind === 'mcp');
  const remoteMcp = selectedMcp.length > 0 ? readRemoteMcp(repoDirectory) : null;
  const stagedPaths = [REPO_MACHINE_MANIFEST];

  for (const item of snapshot.selected) {
    if (item.kind !== 'skill') continue;
    const relative = `${REPO_SKILLS_DIR}/${item.name}`;
    const destination = path.join(repoDirectory, relative);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(snapshot.directory, relative), destination, { recursive: true });
    stagedPaths.push(relative);
  }

  if (remoteMcp) {
    for (const item of selectedMcp) {
      remoteMcp[item.name] = snapshot.mcp[item.name] as McpServerBlock;
    }
    const stable: Record<string, unknown> = {};
    for (const name of Object.keys(remoteMcp).sort()) stable[name] = remoteMcp[name];
    fs.writeFileSync(
      path.join(repoDirectory, REPO_MCP_FILE),
      JSON.stringify(stable, null, 2) + '\n',
      'utf-8',
    );
    stagedPaths.push(REPO_MCP_FILE);
  }

  const manifest: BackupMachineManifest = { appInstanceId: getAppInstanceId(), machineLabel };
  fs.writeFileSync(
    path.join(repoDirectory, REPO_MACHINE_MANIFEST),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
  return stagedPaths;
}

/**
 * Capture every selected live item before network work, then replace those
 * whole items on the fetched branch head. Unselected remote content is never
 * interpreted as deletion and remains byte-for-byte untouched.
 */
export async function runBackup(
  selectedIdsInput: string[],
  dependencies: BackupDependencies = DEFAULT_DEPENDENCIES,
): Promise<BackupRunResult> {
  const selectedIds = [...new Set(selectedIdsInput)];
  if (selectedIds.length === 0) {
    return validationFailure('Select at least one Skill or MCP server before Back up.');
  }

  const captured = await captureSelected(selectedIds, dependencies);
  if ('ok' in captured) return captured;
  const snapshot = captured;

  const binding = loadBinding();
  if (!binding?.remoteUrl) {
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
    return { ok: false, reason: 'not-bound', message: 'Save a Backup remote URL first.' };
  }

  const branch = thisMachineBranchRef();
  try {
    const changed = await withConfigBackupOperation(async () => {
      const sideCar = dependencies.createSideCar();
      await sideCar.ensureClone(binding.remoteUrl);
      await sideCar.fetch();
      const remoteHead = await sideCar.remoteBranchHead(branch);
      await sideCar.materializeCleanBase(remoteHead);
      const stagedPaths = applySelected(sideCar.dir, snapshot, binding.machineLabel);
      const committed = await sideCar.stagePathsAndCommit(
        stagedPaths,
        `backup: ${snapshot.selected.length} selected item(s)`,
      );
      if (committed) await sideCar.pushHead(branch);
      return committed;
    });

    saveIntent(selectedIds);
    log.info(
      'config-backup',
      changed
        ? `pushed ${branch} (${snapshot.selected.length} item(s))`
        : `${branch} already up to date — nothing to push`,
    );
    return { ok: true, pushed: changed, branch, itemCount: snapshot.selected.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('config-backup', `backup to ${branch} failed: ${message}`);
    return { ok: false, reason: 'remote', message };
  } finally {
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
  }
}
