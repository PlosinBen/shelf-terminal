import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  MEMORY_PROCESS_ROLE,
  type MemoryProcessRole,
  type ProcessMemoryRow,
  type ProcessMemorySample,
} from './process-memory';

export interface ProcessCommandResult {
  stdout: string;
  pid?: number;
}

export type ProcessCommandRunner = (
  command: string,
  args: string[],
) => Promise<ProcessCommandResult>;

export interface SnapshotProcessesOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  runCommand?: ProcessCommandRunner;
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${field}: ${String(value)}`);
  }
  return value;
}

function validateSamples(samples: ProcessMemorySample[], source: string): ProcessMemorySample[] {
  if (samples.length === 0) throw new Error(`${source} returned no process rows`);
  const seen = new Set<number>();
  for (const row of samples) {
    assertNonNegativeInteger(row.pid, 'pid');
    if (row.pid === 0) throw new Error('invalid pid: 0');
    if (row.ppid !== undefined) assertNonNegativeInteger(row.ppid, 'ppid');
    assertNonNegativeInteger(row.memoryKiB, 'memoryKiB');
    if (seen.has(row.pid)) throw new Error(`${source} returned duplicate pid ${row.pid}`);
    seen.add(row.pid);
  }
  return samples;
}

/** Parse `ps -axo pid=,ppid=,rss=`. POSIX ps reports RSS in KiB. */
export function parsePsMemoryOutput(output: string): ProcessMemorySample[] {
  const rows = output.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) throw new Error(`unparseable ps row: ${line.trim()}`);
    const [pid, ppid, memoryKiB] = fields.map(Number);
    return { pid, ppid, memoryKiB };
  });
  return validateSamples(rows, 'ps');
}

interface WindowsProcessJson {
  ProcessId?: number | string;
  ParentProcessId?: number | string;
  WorkingSetSize?: number | string;
}

/** Parse PowerShell/CIM JSON. WorkingSetSize is bytes and is normalized to KiB. */
export function parseWindowsMemoryOutput(output: string): ProcessMemorySample[] {
  let parsed: WindowsProcessJson | WindowsProcessJson[];
  try {
    parsed = JSON.parse(output) as WindowsProcessJson | WindowsProcessJson[];
  } catch (error) {
    throw new Error(`unparseable PowerShell process JSON: ${String(error)}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const rows = items.map((item) => {
    const pid = Number(item.ProcessId);
    const ppid = Number(item.ParentProcessId);
    const workingSetBytes = Number(item.WorkingSetSize);
    assertNonNegativeInteger(workingSetBytes, 'WorkingSetSize');
    return { pid, ppid, memoryKiB: Math.ceil(workingSetBytes / 1024) };
  });
  return validateSamples(rows, 'PowerShell');
}

export function parseProcStatPpid(output: string): number {
  const rparen = output.lastIndexOf(')');
  if (rparen < 0) throw new Error('unparseable /proc stat: missing comm terminator');
  const fields = output.slice(rparen + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return assertNonNegativeInteger(ppid, 'ppid');
}

export function parseProcStatusMemoryKiB(output: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(output);
  if (!match) throw new Error('unparseable /proc status: missing VmRSS');
  return assertNonNegativeInteger(Number(match[1]), 'VmRSS');
}

/** Snapshot readable processes from procfs. Vanished/inaccessible entries are benign enumeration races. */
export function snapshotProcessesFromProc(procRoot = '/proc'): ProcessMemorySample[] {
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch (error) {
    throw new Error(`cannot read ${procRoot}: ${String(error)}`);
  }

  const rows: ProcessMemorySample[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    let status: string;
    try {
      stat = fs.readFileSync(join(procRoot, name, 'stat'), 'utf8');
      status = fs.readFileSync(join(procRoot, name, 'status'), 'utf8');
    } catch {
      // A process can exit or become unreadable between readdir and file reads.
      continue;
    }
    rows.push({
      pid: Number(name),
      ppid: parseProcStatPpid(stat),
      memoryKiB: parseProcStatusMemoryKiB(status),
    });
  }
  return validateSamples(rows, 'procfs');
}

export const defaultProcessCommandRunner: ProcessCommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve({ stdout, pid: child.pid });
    });
  });

const WINDOWS_PROCESS_COMMAND = [
  'Get-CimInstance Win32_Process',
  'Select-Object ProcessId,ParentProcessId,WorkingSetSize',
  'ConvertTo-Json -Compress',
].join(' | ');

export async function snapshotProcesses(
  options: SnapshotProcessesOptions = {},
): Promise<ProcessMemorySample[]> {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultProcessCommandRunner;

  if (platform === 'darwin' || platform === 'linux') {
    try {
      const result = await runCommand('ps', ['-axo', 'pid=,ppid=,rss=']);
      return validateSamples(
        parsePsMemoryOutput(result.stdout).filter((row) => row.pid !== result.pid),
        'ps after acquisition-process exclusion',
      );
    } catch (psError) {
      if (platform === 'darwin') throw psError;
      try {
        return snapshotProcessesFromProc(options.procRoot);
      } catch (procError) {
        throw new Error(`process snapshot failed (ps: ${String(psError)}; procfs: ${String(procError)})`);
      }
    }
  }

  if (platform === 'win32') {
    const result = await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_PROCESS_COMMAND,
    ]);
    return validateSamples(
      parseWindowsMemoryOutput(result.stdout).filter((row) => row.pid !== result.pid),
      'PowerShell after acquisition-process exclusion',
    );
  }

  throw new Error(`unsupported process-memory platform: ${platform}`);
}

export function classifyProcessSelf(
  samples: ProcessMemorySample[],
  pid: number,
  role: typeof MEMORY_PROCESS_ROLE.DISPATCHER | typeof MEMORY_PROCESS_ROLE.EXEC,
): ProcessMemoryRow {
  const sample = samples.find((row) => row.pid === pid);
  if (!sample) throw new Error(`memory snapshot missing root pid ${pid}`);
  return { ...sample, role };
}

/** Select an exec root, its descendants, and optional identity-recovered provider processes. */
export function classifyExecProcessTree(
  samples: ProcessMemorySample[],
  rootPid: number,
  supplementaryPids: readonly number[] = [],
): ProcessMemoryRow[] {
  const byPid = new Map(samples.map((sample) => [sample.pid, sample]));
  if (!byPid.has(rootPid)) throw new Error(`memory snapshot missing root pid ${rootPid}`);

  const included = new Set<number>([rootPid, ...supplementaryPids.filter((pid) => byPid.has(pid))]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const sample of samples) {
      if (sample.ppid !== undefined && included.has(sample.ppid) && !included.has(sample.pid)) {
        included.add(sample.pid);
        changed = true;
      }
    }
  }

  const rootRole: MemoryProcessRole = MEMORY_PROCESS_ROLE.EXEC;
  const descendantRole: MemoryProcessRole = MEMORY_PROCESS_ROLE.PROVIDER;
  return samples
    .filter((sample) => included.has(sample.pid))
    .map((sample) => ({
      ...sample,
      role: sample.pid === rootPid ? rootRole : descendantRole,
    }));
}
