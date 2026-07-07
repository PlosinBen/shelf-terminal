import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

/**
 * Real-git round-trip: a temp BARE repo on disk stands in for the GitHub remote
 * (no network). Machine A backs up its branch; machine B fetches + reads it.
 * Exercises the whole transport contract of side-car without mocking git.
 */

let userDataDir: string; // what the electron mock returns for getPath('userData')

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

const { createSideCar } = await import('./side-car');

let root: string;
let bareRemote: string;

async function makeBareRemote(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await simpleGit().raw(['init', '--bare', dir]);
}

/** Build a side-car whose <userData> is an isolated tmp dir (one per "machine"). */
function machine(name: string) {
  userDataDir = path.join(root, name);
  fs.mkdirSync(userDataDir, { recursive: true });
  return createSideCar();
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sidecar-'));
  bareRemote = path.join(root, 'remote.git');
  await makeBareRemote(bareRemote);
});
afterEach(() => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe('config-backup side-car round-trip', () => {
  it('machine A pushes its branch; machine B fetches, lists, and reads it back', async () => {
    // --- Machine A: backup ---
    const a = machine('machineA');
    await a.ensureClone(bareRemote);
    await a.checkoutBranch('backup/aaa');
    fs.mkdirSync(path.join(a.dir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(a.dir, 'skills', 'demo', 'SKILL.md'), '# demo skill\n', 'utf-8');
    expect(await a.stageAllAndCommit('backup from A')).toBe(true);
    await a.push('backup/aaa');

    // --- Machine B: import side (read-only) ---
    const b = machine('machineB');
    await b.ensureClone(bareRemote);
    await b.fetch();

    const branches = await b.listBackupBranches();
    const aBranch = branches.find((x) => x.appInstanceId === 'aaa');
    expect(aBranch).toBeDefined();
    expect(aBranch!.branch).toBe('backup/aaa');
    expect(aBranch!.ref).toBe('origin/backup/aaa');

    const files = await b.listFilesAtRef(aBranch!.ref);
    expect(files).toContain('skills/demo/SKILL.md');

    expect(await b.readFileAtRef(aBranch!.ref, 'skills/demo/SKILL.md')).toBe('# demo skill\n');
    expect(await b.readFileAtRef(aBranch!.ref, 'skills/nope/SKILL.md')).toBeNull();
  });

  it('stageAllAndCommit returns false when the tree is unchanged', async () => {
    const a = machine('machineA');
    await a.ensureClone(bareRemote);
    await a.checkoutBranch('backup/aaa');
    fs.writeFileSync(path.join(a.dir, 'x.txt'), 'v1', 'utf-8');
    expect(await a.stageAllAndCommit('first')).toBe(true);
    expect(await a.stageAllAndCommit('noop')).toBe(false);
  });

  it('snapshot semantics: removing a live file stages a deletion on the next backup', async () => {
    const a = machine('machineA');
    await a.ensureClone(bareRemote);
    await a.checkoutBranch('backup/aaa');
    fs.writeFileSync(path.join(a.dir, 'keep.txt'), 'k', 'utf-8');
    fs.writeFileSync(path.join(a.dir, 'gone.txt'), 'g', 'utf-8');
    await a.stageAllAndCommit('two files');
    await a.push('backup/aaa');

    fs.rmSync(path.join(a.dir, 'gone.txt'));
    expect(await a.stageAllAndCommit('drop gone')).toBe(true);
    await a.push('backup/aaa');

    const b = machine('machineB');
    await b.ensureClone(bareRemote);
    await b.fetch();
    const files = await b.listFilesAtRef('origin/backup/aaa');
    expect(files).toContain('keep.txt');
    expect(files).not.toContain('gone.txt');
  });

  it('re-ensureClone on an existing clone is idempotent (reuses, keeps origin)', async () => {
    const a = machine('machineA');
    await a.ensureClone(bareRemote);
    await a.checkoutBranch('backup/aaa');
    fs.writeFileSync(path.join(a.dir, 'x.txt'), 'v1', 'utf-8');
    await a.stageAllAndCommit('c');
    await a.push('backup/aaa');
    await expect(a.ensureClone(bareRemote)).resolves.toBeUndefined();
    const remotes = await simpleGit(a.dir).getRemotes(true);
    expect(remotes.find((r) => r.name === 'origin')?.refs.fetch).toBe(bareRemote);
  });
});
