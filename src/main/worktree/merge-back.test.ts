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
const mergeCommitCount = async (cwd: string, ref: string) => Number((await git(cwd, `rev-list --merges --count ${ref}`)).stdout.trim());

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
  it('feature worktree with modified tracked file → feature-dirty, main untouched', async () => {
    const before = await tip(base, 'main');
    fs.writeFileSync(path.join(feature, 'f.txt'), 'uncommitted edit');

    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });

    expect(res.outcome).toBe('feature-dirty');
    expect(await tip(base, 'main')).toBe(before);
    expect(fs.readFileSync(path.join(feature, 'f.txt'), 'utf-8')).toBe('uncommitted edit');
    expect((res as any).error).toContain('git status --porcelain');
  });

  it('feature worktree with untracked non-ignored file → feature-dirty, main untouched', async () => {
    const before = await tip(base, 'main');
    fs.writeFileSync(path.join(feature, 'scratch.txt'), 'keep me');

    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });

    expect(res.outcome).toBe('feature-dirty');
    expect(await tip(base, 'main')).toBe(before);
    expect(fs.readFileSync(path.join(feature, 'scratch.txt'), 'utf-8')).toBe('keep me');
    expect((res as any).error).toContain('scratch.txt');
  });

  it('feature worktree with ignored file only → merge-back is allowed', async () => {
    await commit(feature, '.gitignore', '*.log\n');
    fs.writeFileSync(path.join(feature, 'debug.log'), 'ignored');

    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });

    expect(res.outcome).toBe('merged');
    expect(await tip(base, 'main')).toBe(await tip(feature, 'HEAD'));
    expect(fs.readFileSync(path.join(feature, 'debug.log'), 'utf-8')).toBe('ignored');
  });

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
    // The error names the target branch so the agent knows what's blocked.
    expect((res as any).error).toContain("'main'");
  });

  it('non-ff: main advanced past the fork → non-ff (agent must rebase and retry)', async () => {
    // Advance main beyond the feature fork, then free the ref (topology a push path).
    await commit(base, 'a.txt', 'c2-on-main');
    const mainAhead = await tip(base, 'main');
    await git(base, 'checkout -b other');
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('non-ff');
    expect(await tip(base, 'main')).toBe(mainAhead); // untouched
    // The error names the target branch + the attempted command so the agent
    // knows WHICH branch to rebase onto (topology a → push path).
    expect((res as any).error).toContain("'main'");
    expect((res as any).error).toContain('git push . HEAD:main');
    expect((res as any).error).toContain("rebase this worktree onto 'main'");
    expect((res as any).error).not.toMatch(/merge 'main' into this worktree/i);
  });

  it('non-ff recovery: rebase feature onto main, retry finish, and keep main linear', async () => {
    await commit(base, 'a.txt', 'c2-on-main');
    await git(base, 'checkout -b other');

    const blocked = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(blocked.outcome).toBe('non-ff');
    expect((blocked as any).error).toContain("rebase this worktree onto 'main'");

    await git(feature, 'rebase main');

    const retried = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(retried.outcome).toBe('merged');
    expect(await tip(base, 'main')).toBe(await tip(feature, 'HEAD'));
    expect(await mergeCommitCount(base, 'main')).toBe(0);
  });

  it('non-ff when base is on a diverged main → non-ff (caught at the push, not base-tree)', async () => {
    await commit(base, 'a.txt', 'c2-on-main'); // main ahead, base still on main
    const mainAhead = await tip(base, 'main');
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: 'main', featureBranch: 'feature' });
    expect(res.outcome).toBe('non-ff');
    expect(await tip(base, 'main')).toBe(mainAhead);
    // A diverged push is rejected as non-ff (not denyCurrentBranch), so it's the
    // push path that reports it — the error names that command + the target.
    expect((res as any).error).toContain("'main'");
    expect((res as any).error).toContain('git push . HEAD:main');
    expect((res as any).error).toContain("rebase this worktree onto 'main'");
    expect((res as any).error).not.toMatch(/merge 'main' into this worktree/i);
  });

  it('empty baseBranch → fail-loud error', async () => {
    const res = await mergeBackFastForward({ connector, featureCwd: feature, baseCwd: base, baseBranch: '', featureBranch: 'feature' });
    expect(res.outcome).toBe('error');
  });
});
