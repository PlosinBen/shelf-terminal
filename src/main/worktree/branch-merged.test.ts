import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkBranchMerged } from './branch-merged';

// Real-git fixtures: the "merged vs ahead" distinction is what drives the
// Abandon popup's adaptive warning, so exercise actual git (the `+`-prefixed
// worktree-checkout line is the fragile parsing bit).

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

const connector = {
  exec: (cwd: string, cmd: string): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile('sh', ['-c', cmd], { cwd, env: GIT_ENV as NodeJS.ProcessEnv }, (error: any, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve({ stdout, stderr });
      });
    }),
};

const git = (cwd: string, args: string) => connector.exec(cwd, `git ${args}`);

let root: string;
let base: string;

async function commit(cwd: string, file: string, msg: string) {
  fs.writeFileSync(path.join(cwd, file), msg);
  await git(cwd, `add ${file}`);
  await git(cwd, `commit -m ${JSON.stringify(msg)}`);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  base = path.join(root, 'repo');
  fs.mkdirSync(base);
  await git(base, 'init -b main');
  await commit(base, 'a.txt', 'c1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkBranchMerged', () => {
  it('unmerged branch with commits ahead → merged:false, aheadCount>0', async () => {
    const feature = path.join(root, 'repo-feature');
    await git(base, `worktree add -b feature ${JSON.stringify(feature)}`);
    await commit(feature, 'f.txt', 'f1');
    await commit(feature, 'g.txt', 'f2');

    const info = await checkBranchMerged(connector, base, 'main', 'feature');
    expect(info.merged).toBe(false);
    expect(info.aheadCount).toBe(2);
  });

  it('branch whose commits are on the target → merged:true, aheadCount 0', async () => {
    // feature ahead of main, then fast-forward main up to it → now merged.
    const feature = path.join(root, 'repo-feature');
    await git(base, `worktree add -b feature ${JSON.stringify(feature)}`);
    await commit(feature, 'f.txt', 'f1');
    await git(base, 'merge --ff-only feature'); // base (on main) ff's up to feature

    const info = await checkBranchMerged(connector, base, 'main', 'feature');
    expect(info.merged).toBe(true);
    expect(info.aheadCount).toBe(0);
  });

  it('branch identical to target (no commits) → merged:true, aheadCount 0', async () => {
    await git(base, 'branch feature'); // points at main's tip
    const info = await checkBranchMerged(connector, base, 'main', 'feature');
    expect(info.merged).toBe(true);
    expect(info.aheadCount).toBe(0);
  });

  it('empty target or branch → merged:false, aheadCount 0 (no git call)', async () => {
    expect(await checkBranchMerged(connector, base, '', 'feature')).toEqual({ merged: false, aheadCount: 0 });
    expect(await checkBranchMerged(connector, base, 'main', '')).toEqual({ merged: false, aheadCount: 0 });
  });
});
