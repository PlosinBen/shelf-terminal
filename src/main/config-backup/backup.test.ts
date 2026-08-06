import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

let userDataDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

const { runBackup } = await import('./backup');
const { saveBinding, thisMachineBranchRef } = await import('./binding-store');
const { loadIntent, saveIntent } = await import('./intent-store');
const { createSideCar } = await import('./side-car');

let root: string;
let bareRemote: string;
const GIT_HEAVY_TIMEOUT = 20_000;

function seedSkill(name: string, files: Record<string, string | Buffer> = {}): void {
  const dir = path.join(userDataDir, 'skills', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

function replaceSkill(name: string, files: Record<string, string | Buffer> = {}): void {
  fs.rmSync(path.join(userDataDir, 'skills', 'skills', name), { recursive: true, force: true });
  seedSkill(name, files);
}

function seedMcp(servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify(servers, null, 2));
}

async function readBranch(branch: string): Promise<{
  files: string[];
  read: (relative: string) => Promise<string | null>;
}> {
  const readerUserData = fs.mkdtempSync(path.join(root, 'reader-'));
  const previous = userDataDir;
  userDataDir = readerUserData;
  const sideCar = createSideCar();
  await sideCar.ensureClone(bareRemote);
  await sideCar.fetch();
  const ref = `origin/${branch}`;
  const files = await sideCar.listFilesAtRef(ref);
  userDataDir = previous;
  return { files, read: (relative) => sideCar.readFileAtRef(ref, relative) };
}

async function mutateRemoteBranch(
  branch: string,
  mutate: (directory: string) => void,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(root, 'remote-writer-'));
  await simpleGit().clone(bareRemote, directory, ['--branch', branch]);
  const git = simpleGit(directory);
  await git.addConfig('user.name', 'Backup Test');
  await git.addConfig('user.email', 'backup-test@shelf.local');
  mutate(directory);
  await git.add(['-A']);
  await git.commit('test: mutate remote branch');
  await git.push('origin', branch);
}

async function remoteHead(branch: string): Promise<string> {
  return (await simpleGit().raw(['--git-dir', bareRemote, 'rev-parse', `refs/heads/${branch}`])).trim();
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-backup-'));
  bareRemote = path.join(root, 'remote.git');
  fs.mkdirSync(bareRemote, { recursive: true });
  await simpleGit().raw(['init', '--bare', bareRemote]);
  userDataDir = path.join(root, 'machineA');
  fs.mkdirSync(userDataDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe('config-backup runBackup', () => {
  it('returns not-bound only after the selected live payload is recoverable', async () => {
    seedSkill('alpha');

    await expect(runBackup(['skill:alpha'])).resolves.toMatchObject({
      ok: false,
      reason: 'not-bound',
    });
  });

  it('an empty selection performs no enumeration or Git work and leaves intent unchanged', async () => {
    saveIntent(['skill:previous']);
    const enumerate = vi.fn();
    const sideCar = vi.fn();

    const result = await runBackup([], {
      enumerateLiveItems: enumerate,
      createSideCar: sideCar,
    });

    expect(result).toMatchObject({ ok: false, reason: 'validation' });
    expect(enumerate).not.toHaveBeenCalled();
    expect(sideCar).not.toHaveBeenCalled();
    expect(loadIntent()).toEqual(['skill:previous']);
  });

  it('rejects an item deleted after listing before Git and leaves intent unchanged', async () => {
    saveIntent(['skill:previous']);
    saveBinding({ remoteUrl: path.join(root, 'does-not-exist.git'), machineLabel: 'm' });
    const sideCar = vi.fn();

    const result = await runBackup(['skill:gone'], {
      enumerateLiveItems: async () => [{
        id: 'skill:gone',
        kind: 'skill',
        name: 'gone',
        valid: true,
      }],
      createSideCar: sideCar,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'validation',
      itemId: 'skill:gone',
    });
    expect(sideCar).not.toHaveBeenCalled();
    expect(loadIntent()).toEqual(['skill:previous']);
  });

  it('returns a typed remote failure for an unreachable remote', async () => {
    seedSkill('alpha');
    saveBinding({ remoteUrl: path.join(root, 'does-not-exist.git'), machineLabel: 'm' });

    const result = await runBackup(['skill:alpha']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('remote');
      expect(result.message).toBeTruthy();
    }
  });

  it('replaces selected whole items while preserving unselected items and unrelated remote paths', async () => {
    seedSkill('alpha', { 'old.js': 'old', 'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    seedSkill('beta', { 'keep.js': 'keep' });
    seedMcp({
      fs: { type: 'stdio', command: 'old-command' },
      secret: { type: 'http', url: 'https://old.example' },
    });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'work-mac' });

    expect(await runBackup(['skill:alpha', 'skill:beta', 'mcp:fs', 'mcp:secret'])).toMatchObject({
      ok: true,
      pushed: true,
    });
    const branch = thisMachineBranchRef();
    await mutateRemoteBranch(branch, (directory) => {
      fs.writeFileSync(path.join(directory, 'remote-note.txt'), 'leave me alone');
    });

    replaceSkill('alpha', {
      'new.js': 'new',
      '.locked': '',
      '.disabled': '',
    });
    seedMcp({
      fs: { type: 'stdio', command: 'new-command' },
      secret: { type: 'http', url: 'https://local-change.example' },
    });

    const result = await runBackup(['skill:alpha', 'mcp:fs']);
    expect(result).toMatchObject({ ok: true, pushed: true, itemCount: 2 });

    const snapshot = await readBranch(branch);
    expect(snapshot.files).toContain('skills/alpha/new.js');
    expect(snapshot.files).not.toContain('skills/alpha/old.js');
    expect(snapshot.files).not.toContain('skills/alpha/.locked');
    expect(snapshot.files).not.toContain('skills/alpha/.disabled');
    expect(snapshot.files).toContain('skills/beta/keep.js');
    expect(await snapshot.read('remote-note.txt')).toBe('leave me alone');

    const mcp = JSON.parse((await snapshot.read('mcp-servers.json'))!);
    expect(mcp.fs.command).toBe('new-command');
    expect(mcp.secret.url).toBe('https://old.example');
    expect(loadIntent().sort()).toEqual(['mcp:fs', 'skill:alpha']);
  }, GIT_HEAVY_TIMEOUT);

  it('does not inherit files from the remote default branch on a first machine backup', async () => {
    const seed = fs.mkdtempSync(path.join(root, 'default-branch-'));
    await simpleGit(seed).init();
    const git = simpleGit(seed);
    await git.addConfig('user.name', 'Backup Test');
    await git.addConfig('user.email', 'backup-test@shelf.local');
    fs.writeFileSync(path.join(seed, 'main-only.txt'), 'not backup data');
    await git.add(['main-only.txt']);
    await git.commit('seed default branch');
    await git.addRemote('origin', bareRemote);
    await git.push(['-u', 'origin', 'HEAD:main']);

    seedSkill('alpha');
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'm' });
    await runBackup(['skill:alpha']);

    const snapshot = await readBranch(thisMachineBranchRef());
    expect(snapshot.files).toContain('skills/alpha/SKILL.md');
    expect(snapshot.files).not.toContain('main-only.txt');
  }, GIT_HEAVY_TIMEOUT);

  it('leaves malformed remote MCP untouched for Skill-only backup and blocks selected MCP', async () => {
    seedSkill('alpha', { 'version.txt': 'one' });
    seedMcp({ fs: { type: 'stdio', command: 'node' } });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'm' });
    await runBackup(['skill:alpha', 'mcp:fs']);
    const branch = thisMachineBranchRef();

    await mutateRemoteBranch(branch, (directory) => {
      fs.writeFileSync(path.join(directory, 'mcp-servers.json'), '{broken json');
    });
    replaceSkill('alpha', { 'version.txt': 'two' });

    expect(await runBackup(['skill:alpha'])).toMatchObject({ ok: true, pushed: true });
    let snapshot = await readBranch(branch);
    expect(await snapshot.read('mcp-servers.json')).toBe('{broken json');
    expect(await snapshot.read('skills/alpha/version.txt')).toBe('two');
    expect(loadIntent()).toEqual(['skill:alpha']);

    const before = await remoteHead(branch);
    const result = await runBackup(['mcp:fs']);
    expect(result).toMatchObject({ ok: false, reason: 'remote' });
    expect(await remoteHead(branch)).toBe(before);
    expect(loadIntent()).toEqual(['skill:alpha']);
  }, GIT_HEAVY_TIMEOUT);

  it('rejects remote payload symlinks without writing outside the side-car tree', async () => {
    seedSkill('alpha', { 'version.txt': 'one' });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'm' });
    await runBackup(['skill:alpha']);
    const branch = thisMachineBranchRef();
    await mutateRemoteBranch(branch, (directory) => {
      fs.rmSync(path.join(directory, 'machine.json'));
      fs.symlinkSync('../escaped.json', path.join(directory, 'machine.json'));
    });
    replaceSkill('alpha', { 'version.txt': 'two' });
    const before = await remoteHead(branch);

    const result = await runBackup(['skill:alpha']);

    expect(result).toMatchObject({ ok: false, reason: 'remote' });
    expect(await remoteHead(branch)).toBe(before);
    expect(fs.existsSync(path.join(userDataDir, 'escaped.json'))).toBe(false);
  }, GIT_HEAVY_TIMEOUT);

  it('persists the latest successful selected set and skips an unchanged push', async () => {
    seedSkill('alpha');
    seedSkill('beta');
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'm' });

    expect(await runBackup(['skill:alpha'])).toMatchObject({ ok: true, pushed: true });
    expect(loadIntent()).toEqual(['skill:alpha']);
    expect(await runBackup(['skill:alpha'])).toMatchObject({ ok: true, pushed: false });

    expect(await runBackup(['skill:beta'])).toMatchObject({ ok: true, pushed: true });
    expect(loadIntent()).toEqual(['skill:beta']);
    const snapshot = await readBranch(thisMachineBranchRef());
    expect(snapshot.files).toContain('skills/alpha/SKILL.md');
    expect(snapshot.files).toContain('skills/beta/SKILL.md');
  }, GIT_HEAVY_TIMEOUT);
});
