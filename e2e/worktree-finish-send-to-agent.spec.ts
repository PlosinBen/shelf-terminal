import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { openAgentTab } from './helpers';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Finish failure → "Send to agent" E2E (#lifecycle).
 *
 * main is advanced past the fork so the ff merge-back is a non-fast-forward: the
 * Finish popup shows the enhanced error and keeps the worktree. Clicking
 * "Send to agent" hands that error to the worktree's own agent tab (as a queued
 * user message) so the agent can rebase the feature worktree and retry.
 */

const BASE_ID = 'wt-sta-base';
const SUB_ID = 'wt-sta-sub';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV as NodeJS.ProcessEnv }).toString();
}

function makeRepoNonFf(): { root: string; base: string; feature: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sta-'));
  const base = path.join(root, 'repo');
  fs.mkdirSync(base);
  git(base, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(base, 'a.txt'), 'c1');
  git(base, ['add', 'a.txt']);
  git(base, ['commit', '-m', 'c1']);
  // Feature worktree forked here, one commit ahead.
  const feature = path.join(root, 'repo-feature');
  git(base, ['worktree', 'add', '-b', 'feature', feature]);
  fs.writeFileSync(path.join(feature, 'f.txt'), 'f1');
  git(feature, ['add', 'f.txt']);
  git(feature, ['commit', '-m', 'f1']);
  // Advance main past the fork (base is on main) → finish's ff can't fast-forward.
  fs.writeFileSync(path.join(base, 'a.txt'), 'c2-on-main');
  git(base, ['add', 'a.txt']);
  git(base, ['commit', '-m', 'c2-on-main']);
  return { root, base, feature };
}

function seed(userDataDir: string, base: string, feature: string) {
  const projects = [
    { id: BASE_ID, name: 'STA Base', cwd: base, connection: { type: 'local' }, maxTabs: 5 },
    {
      id: SUB_ID, name: 'STA Base', cwd: feature, connection: { type: 'local' }, maxTabs: 5,
      parentProjectId: BASE_ID, worktreeBranch: 'feature', baseBranch: 'main',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

async function openAgentInSub(page: Page) {
  await page.locator('.sidebar-item.worktree-child', { hasText: 'feature' }).click();
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 8_000 });
  await openAgentTab(page);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
}

test.describe('finish failure → Send to agent', () => {
  let userDataDir: string;
  let root: string;
  let base: string;
  let feature: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sta-ud-'));
    ({ root, base, feature } = makeRepoNonFf());
    seed(userDataDir, base, feature);
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 10_000 });
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('non-ff finish shows the error + queues it into the worktree agent tab', async () => {
    await openAgentInSub(page);

    // Right-click the worktree child → Finish (menu now sits over the agent tab).
    await page.locator('.sidebar-item.worktree-child', { hasText: 'feature' }).click({ button: 'right' });
    await page.locator('.context-menu').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('.context-menu-item', { hasText: 'Finish' }).click();

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.conn-btn-next').click();

    // Merge-back is a non-fast-forward → enhanced error shown, worktree kept.
    const err = popup.locator('.worktree-error');
    await expect(err).toContainText('fast-forward', { timeout: 8_000 });
    await expect(err).toContainText("rebase this worktree onto 'main'");
    await expect(err).not.toContainText("merge 'main' into this worktree");
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(1);

    // Send to agent → popup closes and the error lands as a queued user message.
    await err.locator('button', { hasText: 'Send to agent' }).click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    const userMsg = page.locator('.agent-msg-user .agent-msg-content');
    await expect(userMsg.first()).toContainText('finish failed', { timeout: 8_000 });
    await expect(userMsg.first()).toContainText('fast-forward');
    await expect(userMsg.first()).toContainText("rebase this worktree onto 'main'");
    await expect(userMsg.first()).not.toContainText("merge 'main' into this worktree");
  });
});
