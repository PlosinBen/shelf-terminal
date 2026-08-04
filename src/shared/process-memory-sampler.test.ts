import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyExecProcessTree,
  classifyProcessSelf,
  parseProcStatPpid,
  parseProcStatusMemoryKiB,
  parsePsMemoryOutput,
  parseWindowsMemoryOutput,
  snapshotProcesses,
} from './process-memory-sampler';
import { MEMORY_PROCESS_ROLE } from './process-memory';

describe('process-memory parsers', () => {
  it('parses POSIX ps RSS as KiB', () => {
    expect(parsePsMemoryOutput('  10  1  2048\n11 10 512\n')).toEqual([
      { pid: 10, ppid: 1, memoryKiB: 2048 },
      { pid: 11, ppid: 10, memoryKiB: 512 },
    ]);
  });

  it('rejects malformed ps rows instead of returning a partial snapshot', () => {
    expect(() => parsePsMemoryOutput('10 1 2048\nmalformed')).toThrow('unparseable ps row');
  });

  it('normalizes Windows working-set bytes to KiB', () => {
    expect(parseWindowsMemoryOutput(JSON.stringify([
      { ProcessId: 20, ParentProcessId: 1, WorkingSetSize: 2048 },
      { ProcessId: '21', ParentProcessId: '20', WorkingSetSize: '1025' },
    ]))).toEqual([
      { pid: 20, ppid: 1, memoryKiB: 2 },
      { pid: 21, ppid: 20, memoryKiB: 2 },
    ]);
  });

  it('parses proc fields even when comm contains spaces and parentheses', () => {
    expect(parseProcStatPpid('10 (odd (worker) name) S 7 0 0')).toBe(7);
    expect(parseProcStatusMemoryKiB('Name:\tnode\nVmRSS:\t  3456 kB\n')).toBe(3456);
  });
});

describe('snapshotProcesses', () => {
  let procRoot: string;

  beforeEach(() => {
    procRoot = join(tmpdir(), `shelf-memory-proc-${randomUUID()}`);
    fs.mkdirSync(procRoot, { recursive: true });
  });

  afterEach(() => fs.rmSync(procRoot, { recursive: true, force: true }));

  it('excludes the short-lived acquisition process', async () => {
    const rows = await snapshotProcesses({
      platform: 'darwin',
      runCommand: async () => ({ stdout: '10 1 100\n99 10 20\n', pid: 99 }),
    });
    expect(rows).toEqual([{ pid: 10, ppid: 1, memoryKiB: 100 }]);
  });

  it('falls back to procfs when Linux ps output is incompatible', async () => {
    const dir = join(procRoot, '42');
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'stat'), '42 (node worker) S 1 0 0');
    fs.writeFileSync(join(dir, 'status'), 'Name:\tnode\nVmRSS:\t  4096 kB\n');

    const runCommand = vi.fn(async () => ({ stdout: 'unsupported columns' }));
    await expect(snapshotProcesses({ platform: 'linux', procRoot, runCommand })).resolves.toEqual([
      { pid: 42, ppid: 1, memoryKiB: 4096 },
    ]);
    expect(runCommand).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,rss=']);
  });

  it('fails the procfs fallback on a stable malformed process record', async () => {
    const dir = join(procRoot, '42');
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'stat'), '42 malformed');
    fs.writeFileSync(join(dir, 'status'), 'Name:\tnode\nVmRSS:\t  4096 kB\n');

    await expect(snapshotProcesses({
      platform: 'linux',
      procRoot,
      runCommand: async () => { throw new Error('ps unavailable'); },
    })).rejects.toThrow('process snapshot failed');
  });

  it('uses PowerShell/CIM on Windows', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: '{"ProcessId":7,"ParentProcessId":1,"WorkingSetSize":3072}',
    }));
    await expect(snapshotProcesses({ platform: 'win32', runCommand })).resolves.toEqual([
      { pid: 7, ppid: 1, memoryKiB: 3 },
    ]);
    expect(runCommand).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]));
  });
});

describe('process memory classification', () => {
  it('labels the exec root and all tree/identity descendants without process names', () => {
    const rows = classifyExecProcessTree([
      { pid: 10, ppid: 1, memoryKiB: 100 },
      { pid: 11, ppid: 10, memoryKiB: 200 },
      { pid: 12, ppid: 11, memoryKiB: 300 },
      { pid: 40, ppid: 1, memoryKiB: 400 },
      { pid: 41, ppid: 40, memoryKiB: 500 },
      { pid: 90, ppid: 1, memoryKiB: 900 },
    ], 10, [40]);

    expect(rows).toEqual([
      { pid: 10, ppid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.EXEC },
      { pid: 11, ppid: 10, memoryKiB: 200, role: MEMORY_PROCESS_ROLE.PROVIDER },
      { pid: 12, ppid: 11, memoryKiB: 300, role: MEMORY_PROCESS_ROLE.PROVIDER },
      { pid: 40, ppid: 1, memoryKiB: 400, role: MEMORY_PROCESS_ROLE.PROVIDER },
      { pid: 41, ppid: 40, memoryKiB: 500, role: MEMORY_PROCESS_ROLE.PROVIDER },
    ]);
  });

  it('labels only dispatcher self even if its exec children are in the snapshot', () => {
    expect(classifyProcessSelf([
      { pid: 10, ppid: 1, memoryKiB: 100 },
      { pid: 11, ppid: 10, memoryKiB: 200 },
    ], 10, MEMORY_PROCESS_ROLE.DISPATCHER)).toEqual({
      pid: 10,
      ppid: 1,
      memoryKiB: 100,
      role: MEMORY_PROCESS_ROLE.DISPATCHER,
    });
  });
});
