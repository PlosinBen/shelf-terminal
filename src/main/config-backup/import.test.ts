import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

/**
 * Import READ side: after a machine backs up, another machine fetches + lists
 * the available backup sources (with manifest labels + isSelf) and reads a
 * chosen branch's items — all read-only against the remote.
 */

let userDataDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

const { runBackup } = await import('./backup');
const { saveBinding } = await import('./binding-store');
const { listBackupSources, listImportItems, planImport } = await import('./import');

let root: string;
let bareRemote: string;

function seedSkill(name: string, desc: string): void {
  const dir = path.join(userDataDir, 'skills', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
}
function seedMcp(servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify(servers, null, 2));
}

/** Push a second machine's branch straight to the bare (no shared app-instance-id). */
async function pushOtherMachineBranch(): Promise<void> {
  const work = path.join(root, 'other-machine-clone');
  await simpleGit().clone(bareRemote, work);
  const git = simpleGit(work);
  await git.addConfig('user.name', 't', false, 'local');
  await git.addConfig('user.email', 't@t', false, 'local');
  await git.checkout(['-b', 'backup/other-id']);
  fs.mkdirSync(path.join(work, 'skills', 'beta'), { recursive: true });
  fs.writeFileSync(path.join(work, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: from laptop\n---\n');
  fs.writeFileSync(
    path.join(work, 'machine.json'),
    JSON.stringify({ appInstanceId: 'other-id', machineLabel: 'other-laptop' }),
  );
  await git.add(['-A']);
  await git.commit('other machine backup');
  await git.push(['-u', 'origin', 'backup/other-id']);
}

/** Push an arbitrary branch to the bare with the given repo-relative files. */
async function pushBranch(branch: string, files: Record<string, string>): Promise<void> {
  const work = path.join(root, `clone-${branch.replace(/\//g, '-')}`);
  await simpleGit().clone(bareRemote, work);
  const git = simpleGit(work);
  await git.addConfig('user.name', 't', false, 'local');
  await git.addConfig('user.email', 't@t', false, 'local');
  await git.checkout(['-b', branch]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(work, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  await git.add(['-A']);
  await git.commit('seed');
  await git.push(['-u', 'origin', branch]);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-import-'));
  bareRemote = path.join(root, 'remote.git');
  fs.mkdirSync(bareRemote, { recursive: true });
  await simpleGit().raw(['init', '--bare', bareRemote]);
  userDataDir = path.join(root, 'machineA');
  fs.mkdirSync(userDataDir, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe('config-backup import (read side)', () => {
  it('lists sources with manifest labels + isSelf, own branch first', async () => {
    seedSkill('alpha', 'my skill');
    seedMcp({ fs: { type: 'stdio', command: 'node' } });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'work-mac' });
    await runBackup(['skill:alpha', 'mcp:fs']);
    await pushOtherMachineBranch();

    const sources = await listBackupSources();
    expect(sources.length).toBe(2);

    // Own branch sorts first, labelled from this machine's binding.
    expect(sources[0].isSelf).toBe(true);
    expect(sources[0].machineLabel).toBe('work-mac');

    const other = sources.find((s) => s.appInstanceId === 'other-id')!;
    expect(other.isSelf).toBe(false);
    expect(other.machineLabel).toBe('other-laptop');
    expect(other.ref).toBe('origin/backup/other-id');
  });

  it('lists a chosen branch items read-only (skills + mcp, with detail)', async () => {
    seedSkill('alpha', 'my skill');
    seedMcp({ fs: { type: 'stdio', command: 'node' } });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'work-mac' });
    await runBackup(['skill:alpha', 'mcp:fs']);
    await pushOtherMachineBranch();

    const sources = await listBackupSources();
    const other = sources.find((s) => s.appInstanceId === 'other-id')!;
    const items = await listImportItems(other.ref);
    expect(items).toEqual([
      { id: 'skill:beta', kind: 'skill', name: 'beta', detail: 'from laptop' },
    ]);

    const mine = await listImportItems(sources.find((s) => s.isSelf)!.ref);
    expect(mine).toEqual([
      { id: 'skill:alpha', kind: 'skill', name: 'alpha', detail: 'my skill' },
      { id: 'mcp:fs', kind: 'mcp', name: 'fs', detail: 'stdio' },
    ]);
  });

  it('unbound machine → no sources', async () => {
    expect(await listBackupSources()).toEqual([]);
  });

  it('planImport classifies each entry new / identical / differs vs live', async () => {
    // Live: skill "shared" with SKILL.md = X, and mcp "fs".
    const sharedDir = path.join(userDataDir, 'skills', 'skills', 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'SKILL.md'), 'X');
    seedMcp({ fs: { type: 'stdio', command: 'node' } });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'work-mac' });

    // A branch that differs from live in every way.
    await pushBranch('backup/src', {
      'skills/shared/SKILL.md': 'Y',                        // differs
      'skills/shared/extra.txt': 'e',                       // new (live lacks it)
      'skills/beta/SKILL.md': '---\nname: beta\n---\n',     // new skill
      'mcp-servers.json': JSON.stringify({
        fs: { type: 'stdio', command: 'node' },             // identical to live
        git: { type: 'stdio', command: 'git-mcp' },         // new server
      }),
    });

    await listBackupSources(); // clone + fetch
    const ref = 'origin/backup/src';
    const plan = await planImport(ref, ['skill:shared', 'skill:beta', 'mcp:fs', 'mcp:git']);

    const shared = plan.find((p) => p.id === 'skill:shared')!;
    expect(shared.hasConflict).toBe(true);
    const sharedByPath = Object.fromEntries(shared.entries.map((e) => [e.path, e.change]));
    expect(sharedByPath['SKILL.md']).toBe('differs');
    expect(sharedByPath['extra.txt']).toBe('new');
    const skillMd = shared.entries.find((e) => e.path === 'SKILL.md')!;
    expect(skillMd.live).toBe('X');
    expect(skillMd.backup).toBe('Y');

    expect(plan.find((p) => p.id === 'skill:beta')!.hasConflict).toBe(false);
    expect(plan.find((p) => p.id === 'mcp:fs')!.entries[0].change).toBe('identical');
    expect(plan.find((p) => p.id === 'mcp:git')!.entries[0].change).toBe('new');
  });
});
