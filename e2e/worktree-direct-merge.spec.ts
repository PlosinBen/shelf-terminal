import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { openAgentTab, sendAgentPrompt } from './helpers';
import { WORKTREE_MERGE as M } from '../src/shared/worktree-merge';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const gitEnv = {
  ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
};
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv }).toString().trim();
}
test.describe('direct worktree merge bridge', () => {
  let root: string, base: string, feature: string, userData: string;
  let app: ElectronApplication, page: Page;
  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-direct-merge-'));
    base = path.join(root, 'repo'); feature = path.join(root, 'child'); userData = path.join(root, 'user-data');
    fs.mkdirSync(base); fs.mkdirSync(userData);
    git(base, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(base, '.gitignore'), '.agent/\n.tmp/\n');
    git(base, ['add', '.gitignore']); git(base, ['commit', '-m', 'base']);
    git(base, ['branch', 'integration']);
    git(base, ['worktree', 'add', '-b', 'feature', feature]);
    git(feature, ['commit', '--allow-empty', '-m', 'feature']);
    fs.mkdirSync(path.join(feature, '.agent/features'), { recursive: true });
    fs.writeFileSync(path.join(feature, '.agent/features/keep.md'), '# retain note\n');
    fs.writeFileSync(path.join(userData, 'projects.json'), JSON.stringify([
      { id: 'base', name: 'Merge Base', cwd: base, connection: { type: 'local' }, maxTabs: 5 },
      { id: 'child', name: 'Merge Base', cwd: feature, connection: { type: 'local' }, maxTabs: 5,
        parentProjectId: 'base', worktreeBranch: 'feature', baseBranch: 'main', featureNoteDir: '.agent/features' },
    ]));
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'test', SHELF_TEST_MODE: '1' } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app');
    await page.locator('.sidebar-item.worktree-child').click();
    await page.locator('.connect-prompt').click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
    await openAgentTab(page);
  });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && fs.existsSync(path.join(userData, 'logs'))) {
      for (const file of fs.readdirSync(path.join(userData, 'logs'), { recursive: true })) {
        if (String(file).endsWith('.log')) await info.attach('main-log', {
          body: fs.readFileSync(path.join(userData, 'logs', String(file))), contentType: 'text/plain',
        });
      }
    }
    await app?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function merge(target: string) {
    const replies = page.locator('.agent-msg-reply').filter({ hasText: 'worktree_merge' });
    const before = await replies.count();
    await sendAgentPrompt(page, `worktree_merge:${target}`);
    await expect(replies).toHaveCount(before + 1, { timeout: 15000 });
    const result = JSON.parse(await replies.last().locator('pre code').innerText());
    await expect(page.locator('.worktree-dialog')).toHaveCount(0);
    return { isError: result.isError, receipt: JSON.parse(result.text) };
  }
  async function expectRetained() {
    expect(fs.readFileSync(path.join(feature, '.agent/features/keep.md'), 'utf8')).toBe('# retain note\n');
    expect(git(base, ['branch', '--list', 'feature'])).not.toBe('');
    await expect(page.locator('.sidebar-item.worktree-child.active')).toHaveCount(1);
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
    const projects = await page.evaluate(() => window.shelfApi.project.getAll());
    expect(projects.some(p => p.id === 'child')).toBe(true);
    await sendAgentPrompt(page, 'text:session survived direct merge');
    await expect(page.locator('.agent-messages')).toContainText('session survived direct merge');
  }
  for (const target of ['main', 'integration']) {
    test(`merges into ${target}, returns the source commit and retains the environment`, async () => {
      const commit = git(feature, ['rev-parse', 'HEAD']);
      const before = git(base, ['rev-parse', 'main']);
      expect(await merge(target)).toEqual({ isError: false, receipt: { outcome: M.OUTCOME.MERGED, sourceCommit: commit, targetBranch: target } });
      expect(git(base, ['rev-parse', target])).toBe(commit);
      if (target !== 'main') expect(git(base, ['rev-parse', 'main'])).toBe(before);
      // Repeating after a known successful receipt is an already-merged success.
      expect((await merge(target)).isError).toBe(false);
      await expectRetained();
      await expect(page.locator('.agent-messages')).toContainText(M.TOOL);
    });
  }
  test('merges a detached source without deleting its branch', async () => {
    const branchCommit = git(feature, ['rev-parse', 'feature']);
    git(feature, ['checkout', '--detach']);
    git(feature, ['commit', '--allow-empty', '-m', 'detached']);
    const commit = git(feature, ['rev-parse', 'HEAD']);
    expect((await merge('main')).receipt.sourceCommit).toBe(commit);
    expect(git(base, ['rev-parse', 'main'])).toBe(commit);
    expect(git(base, ['rev-parse', 'feature'])).toBe(branchCommit);
    await expectRetained();
  });
  for (const outcome of [M.OUTCOME.NON_FF, M.OUTCOME.FEATURE_DIRTY, M.OUTCOME.BASE_DIRTY, M.OUTCOME.ERROR]) {
    test(`returns ${outcome} to the agent without moving the target`, async () => {
      if (outcome === M.OUTCOME.NON_FF) git(base, ['commit', '--allow-empty', '-m', 'diverged']);
      if (outcome === M.OUTCOME.FEATURE_DIRTY) fs.writeFileSync(path.join(feature, 'uncommitted'), 'retain');
      if (outcome === M.OUTCOME.BASE_DIRTY) fs.writeFileSync(path.join(base, 'uncommitted'), 'retain');
      const before = git(base, ['rev-parse', 'main']);
      const result = await merge(outcome === M.OUTCOME.ERROR ? 'missing-target' : 'main');
      expect(result.isError).toBe(true);
      expect(result.receipt.outcome).toBe(outcome);
      expect(result.receipt.error.length).toBeGreaterThan(0);
      expect(git(base, ['rev-parse', 'main'])).toBe(before);
      if (outcome === M.OUTCOME.ERROR) expect(git(base, ['branch', '--list', 'missing-target'])).toBe('');
      await expectRetained();
    });
  }
});
