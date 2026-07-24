import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeBackFastForward } from './merge-back';

// Real-git fixtures: the ff/non-ff/checked-out behaviour + git's exact error
// wording is the fragile part, so we exercise actual git through a minimal
// exec connector that mirrors the unix connector (reject with stderr on failure).

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
const tip = async (cwd: string, ref: string) => (await git(cwd, `rev-parse ${ref}`)).stdout.trim();

let root: string;
let base: string;
let feature: string;

async function commit(cwd: string, file: string, msg: string) {
  fs.writeFileSync(path.join(cwd, file), msg);
  await git(cwd, `add ${file}`);
  await git(cwd, `commit -m ${JSON.stringify(msg)}`);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));
  base = path.join(root, 'repo');
  fs.mkdirSync(base);
  await git(base, 'init -b main');
  await commit(base, 'a.txt', 'c1');
  // Cut the feature worktree from main, add a feature commit ahead of main.
  feature = path.join(root, 'repo-feature');
  await git(base, `worktree add -b feature ${JSON.stringify(feature)}`);
  await commit(feature, 'f.txt', 'f1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mergeBackFastForward', () => {
  it('topology (a): base off baseBranch → push ff, baseBranch == feature tip', async () => {
    await git(base, 'checkout -b other'); // free the `main` ref
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('merged');
    expect(await tip(base, 'main')).toBe(await tip(feature, 'HEAD'));
  });

  it('topology (b): base on baseBranch + clean → base-tree ff', async () => {
    // base stays on main → push is refused (denyCurrentBranch) → base-tree ff.
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('merged');
    expect(await tip(base, 'main')).toBe(await tip(feature, 'HEAD'));
  });

  it('topology (b): base on baseBranch + dirty → base-dirty, main untouched', async () => {
    const before = await tip(base, 'main');
    fs.writeFileSync(path.join(base, 'a.txt'), 'uncommitted edit');
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('base-dirty');
    expect(await tip(base, 'main')).toBe(before); // not moved
  });

  it('non-ff: main advanced past the fork → non-ff (agent must re-sync)', async () => {
    // Advance main beyond the feature fork, then free the ref (topology a push path).
    await commit(base, 'a.txt', 'c2-on-main');
    const mainAhead = await tip(base, 'main');
    await git(base, 'checkout -b other');
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('non-ff');
    expect(await tip(base, 'main')).toBe(mainAhead); // untouched
  });

  it('non-ff via base-tree path: base on main but diverged → non-ff', async () => {
    await commit(base, 'a.txt', 'c2-on-main'); // main ahead, base still on main
    const mainAhead = await tip(base, 'main');
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('non-ff');
    expect(await tip(base, 'main')).toBe(mainAhead);
  });

  it('empty baseBranch → fail-loud error', async () => {
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: '', featureBranch: 'feature' });
    expect(res.outcome).toBe('error');
  });
});
