import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import type { ImportApplyDependencies } from './import';

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
const { listBackupSources, listImportItems, applyImport } = await import('./import');
const { createSideCar } = await import('./side-car');
const { resetPinnedImportSourcesForTests } = await import('./source-revisions');

const liveSkillFile = (name: string, rel: string) =>
  path.join(userDataDir, 'skills', 'skills', name, rel);
const readLive = (name: string, rel: string) => fs.readFileSync(liveSkillFile(name, rel), 'utf-8');
const readLiveMcp = () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'mcp-servers.json'), 'utf-8'));

let root: string;
let bareRemote: string;
const GIT_HEAVY_TIMEOUT = 20_000;

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

async function advanceBranch(branch: string, mutate: (directory: string) => void): Promise<void> {
  const work = path.join(root, `advance-${branch.replace(/\//g, '-')}`);
  await simpleGit().clone(bareRemote, work, ['--branch', branch]);
  const git = simpleGit(work);
  await git.addConfig('user.name', 't', false, 'local');
  await git.addConfig('user.email', 't@t', false, 'local');
  mutate(work);
  await git.add(['-A']);
  await git.commit('advance');
  await git.push('origin', branch);
}

function applyDependencies(
  overrides: Partial<ImportApplyDependencies> = {},
): ImportApplyDependencies {
  return {
    createSideCar,
    notifySkillsChanged: () => {},
    notifyMcpChanged: () => {},
    ...overrides,
  };
}

function stagingDirectories(): string[] {
  return fs.readdirSync(userDataDir).filter((name) => name.startsWith('.config-backup-import-'));
}

async function discoverSource(branch = 'backup/src') {
  return (await listBackupSources(bareRemote)).find((source) => source.branch === branch)!;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-import-'));
  bareRemote = path.join(root, 'remote.git');
  fs.mkdirSync(bareRemote, { recursive: true });
  await simpleGit().raw(['init', '--bare', bareRemote]);
  userDataDir = path.join(root, 'machineA');
  fs.mkdirSync(userDataDir, { recursive: true });
  resetPinnedImportSourcesForTests();
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

    const sources = await listBackupSources(bareRemote);
    expect(sources.length).toBe(2);

    // Own branch sorts first, labelled from this machine's binding.
    expect(sources[0].isSelf).toBe(true);
    expect(sources[0].machineLabel).toBe('work-mac');

    const other = sources.find((s) => s.appInstanceId === 'other-id')!;
    expect(other.isSelf).toBe(false);
    expect(other.machineLabel).toBe('other-laptop');
    expect(other.sourceRevision).toEqual(expect.any(String));
  }, GIT_HEAVY_TIMEOUT);

  it('lists a chosen branch items read-only (skills + mcp, with detail)', async () => {
    seedSkill('alpha', 'my skill');
    seedMcp({ fs: { type: 'stdio', command: 'node' } });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'work-mac' });
    await runBackup(['skill:alpha', 'mcp:fs']);
    await pushOtherMachineBranch();

    const sources = await listBackupSources(bareRemote);
    const other = sources.find((s) => s.appInstanceId === 'other-id')!;
    const items = await listImportItems(bareRemote, other.sourceRevision);
    expect(items.items).toEqual([
      { id: 'skill:beta', kind: 'skill', name: 'beta', detail: 'from laptop', valid: true },
    ].map((item) => ({ ...item, impact: 'new' })));

    const mineSource = sources.find((s) => s.isSelf)!;
    const mine = await listImportItems(bareRemote, mineSource.sourceRevision);
    expect(mine.items).toEqual([
      { id: 'skill:alpha', kind: 'skill', name: 'alpha', detail: 'my skill', valid: true },
      { id: 'mcp:fs', kind: 'mcp', name: 'fs', detail: 'stdio', valid: true },
    ].map((item) => ({ ...item, impact: 'replace-local' })));
  }, GIT_HEAVY_TIMEOUT);

  it('an empty transient URL performs no discovery', async () => {
    expect(await listBackupSources('')).toEqual([]);
  });

  it('validates source items, reports malformed MCP separately, and leaves the side-car clean', async () => {
    seedSkill('alpha', 'local alpha');
    await pushBranch('backup/source', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: remote alpha\n---\n',
      'skills/broken/SKILL.md': '---\nname: wrong-name\n---\n',
      'mcp-servers.json': '{broken',
      'machine.json': JSON.stringify({ appInstanceId: 'source', machineLabel: 'source-machine' }),
    });

    const source = (await listBackupSources(bareRemote))[0];
    const sideCar = createSideCar();
    const before = await simpleGit(sideCar.dir).status();
    const result = await listImportItems(bareRemote, source.sourceRevision);
    const after = await simpleGit(sideCar.dir).status();

    expect(result.items).toEqual([
      {
        id: 'skill:alpha',
        kind: 'skill',
        name: 'alpha',
        detail: 'remote alpha',
        valid: true,
        impact: 'replace-local',
      },
      expect.objectContaining({
        id: 'skill:broken',
        valid: false,
        impact: 'new',
        invalidReason: expect.stringContaining('does not match folder'),
      }),
    ]);
    expect(result.issues).toEqual([
      { scope: 'mcp', message: 'mcp-servers.json is not a keyed JSON object.' },
    ]);
    expect(after.files).toEqual(before.files);
    expect(after.staged).toEqual(before.staged);
  }, GIT_HEAVY_TIMEOUT);

  it('keeps a discovered source pinned when its remote branch advances', async () => {
    await pushBranch('backup/source', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: version one\n---\n',
      'machine.json': JSON.stringify({ appInstanceId: 'source', machineLabel: 'source-machine' }),
    });
    const source = (await listBackupSources(bareRemote))[0];

    await advanceBranch('backup/source', (directory) => {
      fs.writeFileSync(
        path.join(directory, 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: version two\n---\n',
      );
      fs.mkdirSync(path.join(directory, 'skills', 'beta'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'skills', 'beta', 'SKILL.md'),
        '---\nname: beta\ndescription: added later\n---\n',
      );
    });

    const pinned = await listImportItems(bareRemote, source.sourceRevision);
    expect(pinned.items.map((item) => item.id)).toEqual(['skill:alpha']);
    expect(pinned.items[0].detail).toBe('version one');
  }, GIT_HEAVY_TIMEOUT);

  it('transactionally replaces whole selected items, preserves local markers, and leaves unrelated items', async () => {
    seedSkill('shared', 'local shared');
    fs.writeFileSync(liveSkillFile('shared', 'old-only.txt'), 'remove me');
    fs.writeFileSync(liveSkillFile('shared', '.locked'), '');
    fs.writeFileSync(liveSkillFile('shared', '.disabled'), '');
    seedSkill('unrelated', 'leave local');
    seedMcp({
      existing: { type: 'stdio', command: 'old' },
      untouched: { type: 'http', url: 'https://local.example' },
    });
    await pushBranch('backup/src', {
      'skills/shared/SKILL.md': '---\nname: shared\ndescription: source shared\n---\n',
      'skills/shared/new-only.txt': 'source file',
      'skills/shared/.locked': 'source marker ignored',
      'skills/beta/SKILL.md': '---\nname: beta\ndescription: source beta\n---\n',
      'skills/beta/.disabled': 'source marker ignored',
      'mcp-servers.json': JSON.stringify({
        existing: { type: 'stdio', command: 'new' },
        git: { type: 'stdio', command: 'git-mcp' },
      }),
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();
    const listed = await listImportItems(bareRemote, source.sourceRevision);
    expect(listed.items.find((item) => item.id === 'skill:shared')?.impact).toBe('replace-local');
    fs.writeFileSync(
      liveSkillFile('shared', 'SKILL.md'),
      '---\nname: shared\ndescription: changed after listing\n---\n',
    );

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:shared', 'skill:beta', 'mcp:existing', 'mcp:git'],
      applyDependencies(),
    );

    expect(result).toMatchObject({ ok: true, skillsWritten: 2, mcpWritten: 2 });
    if (!result.ok) throw new Error(result.message);
    expect(result.itemsChanged).toEqual(['skill:shared', 'skill:beta', 'mcp:existing', 'mcp:git']);
    expect(readLive('shared', 'new-only.txt')).toBe('source file');
    expect(fs.existsSync(liveSkillFile('shared', 'old-only.txt'))).toBe(false);
    expect(fs.existsSync(liveSkillFile('shared', '.locked'))).toBe(true);
    expect(fs.existsSync(liveSkillFile('shared', '.disabled'))).toBe(true);
    expect(fs.existsSync(liveSkillFile('beta', '.locked'))).toBe(false);
    expect(fs.existsSync(liveSkillFile('beta', '.disabled'))).toBe(false);
    expect(readLive('unrelated', 'SKILL.md')).toContain('leave local');
    expect(readLiveMcp()).toEqual({
      existing: { type: 'stdio', command: 'new' },
      git: { type: 'stdio', command: 'git-mcp' },
      untouched: { type: 'http', url: 'https://local.example' },
    });
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);

  it('rejects a malformed selected source item after staging siblings but before live writes', async () => {
    await pushBranch('backup/src', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: valid\n---\n',
      'skills/broken/SKILL.md': '---\nname: wrong\n---\n',
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:alpha', 'skill:broken'],
      applyDependencies(),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'validation',
      itemId: 'skill:broken',
      rollback: 'not-needed',
    });
    expect(fs.existsSync(liveSkillFile('alpha', 'SKILL.md'))).toBe(false);
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);

  it('rejects malformed local MCP preservation before applying a staged Skill', async () => {
    seedSkill('alpha', 'local alpha');
    fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), '{broken local json');
    await pushBranch('backup/src', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: source alpha\n---\n',
      'mcp-servers.json': JSON.stringify({ existing: { type: 'stdio', command: 'new' } }),
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:alpha', 'mcp:existing'],
      applyDependencies(),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'validation',
      itemId: 'mcp:existing',
      rollback: 'not-needed',
    });
    expect(readLive('alpha', 'SKILL.md')).toContain('local alpha');
    expect(fs.readFileSync(path.join(userDataDir, 'mcp-servers.json'), 'utf-8')).toBe('{broken local json');
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);

  it('rejects empty and unknown selections without creating staging', async () => {
    expect(await applyImport(bareRemote, 'unused', [], applyDependencies())).toMatchObject({
      ok: false,
      phase: 'validation',
      rollback: 'not-needed',
    });
    expect(await applyImport(bareRemote, 'unused', ['settings:all'], applyDependencies())).toMatchObject({
      ok: false,
      phase: 'validation',
      itemId: 'settings:all',
      rollback: 'not-needed',
    });
    expect(stagingDirectories()).toEqual([]);
  });

  it('rolls back earlier Skill swaps when a later canonical write fails', async () => {
    seedSkill('alpha', 'local alpha');
    seedSkill('beta', 'local beta');
    await pushBranch('backup/src', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: source alpha\n---\n',
      'skills/beta/SKILL.md': '---\nname: beta\ndescription: source beta\n---\n',
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:alpha', 'skill:beta'],
      applyDependencies({
        beforeCanonicalWrite: (itemId) => {
          if (itemId === 'skill:beta') throw new Error('injected write failure');
        },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'apply',
      itemId: 'skill:beta',
      rollback: 'completed',
    });
    expect(readLive('alpha', 'SKILL.md')).toContain('local alpha');
    expect(readLive('beta', 'SKILL.md')).toContain('local beta');
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);

  it('returns a typed rollback failure with the affected item', async () => {
    seedSkill('alpha', 'local alpha');
    seedSkill('beta', 'local beta');
    await pushBranch('backup/src', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: source alpha\n---\n',
      'skills/beta/SKILL.md': '---\nname: beta\ndescription: source beta\n---\n',
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:alpha', 'skill:beta'],
      applyDependencies({
        beforeCanonicalWrite: (itemId) => {
          if (itemId === 'skill:beta') throw new Error('injected write failure');
        },
        beforeRollback: (itemId) => {
          if (itemId === 'skill:alpha') throw new Error('injected rollback failure');
        },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      phase: 'rollback',
      itemId: 'skill:alpha',
      rollback: 'failed',
    });
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);

  it('rolls Skills back and preserves the MCP file when the atomic MCP step fails', async () => {
    seedSkill('alpha', 'local alpha');
    seedMcp({ existing: { type: 'stdio', command: 'old' } });
    const previousMcp = fs.readFileSync(path.join(userDataDir, 'mcp-servers.json'));
    await pushBranch('backup/src', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: source alpha\n---\n',
      'mcp-servers.json': JSON.stringify({ existing: { type: 'stdio', command: 'new' } }),
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:alpha', 'mcp:existing'],
      applyDependencies({
        beforeCanonicalWrite: (itemId) => {
          if (itemId === 'mcp:existing') throw new Error('injected MCP failure');
        },
      }),
    );

    expect(result).toMatchObject({ ok: false, phase: 'apply', rollback: 'completed' });
    expect(readLive('alpha', 'SKILL.md')).toContain('local alpha');
    expect(fs.readFileSync(path.join(userDataDir, 'mcp-servers.json'))).toEqual(previousMcp);
    expect(fs.readdirSync(userDataDir).some((name) => name.includes('.import-') && name.endsWith('.tmp'))).toBe(false);
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);

  it('keeps committed canonical data when post-commit projections fail', async () => {
    seedSkill('alpha', 'local alpha');
    seedMcp({ existing: { type: 'stdio', command: 'old' } });
    await pushBranch('backup/src', {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: source alpha\n---\n',
      'mcp-servers.json': JSON.stringify({ existing: { type: 'stdio', command: 'new' } }),
      'machine.json': JSON.stringify({ appInstanceId: 'src', machineLabel: 'source' }),
    });
    const source = await discoverSource();

    const result = await applyImport(
      bareRemote,
      source.sourceRevision,
      ['skill:alpha', 'mcp:existing'],
      applyDependencies({
        notifySkillsChanged: () => { throw new Error('projection failed'); },
        notifyMcpChanged: () => { throw new Error('projection failed'); },
      }),
    );

    expect(result).toMatchObject({ ok: true, skillsWritten: 1, mcpWritten: 1 });
    expect(readLive('alpha', 'SKILL.md')).toContain('source alpha');
    expect(readLiveMcp().existing.command).toBe('new');
    expect(stagingDirectories()).toEqual([]);
  }, GIT_HEAVY_TIMEOUT);
});
