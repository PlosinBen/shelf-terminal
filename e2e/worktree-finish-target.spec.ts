import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Finish with a user-selected target (#lifecycle — target moved from the agent
 * to the finish popup). baseBranch is `main` but the user picks `develop` in the
 * target selector: the ff lands on develop, leaving main untouched.
 */

const BASE_ID = 'wt-ftgt-base';
const SUB_ID = 'wt-ftgt-sub';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV as NodeJS.ProcessEnv }).toString();
}

function makeRepo(): { root: string; base: string; feature: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ftgt-'));
  const base = path.join(root, 'repo');
  fs.mkdirSync(base);
  git(base, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(base, 'a.txt'), 'c1');
  git(base, ['add', 'a.txt']);
  git(base, ['commit', '-m', 'c1']);
  // A second integration branch at the same commit — a selectable finish target.
  // Not checked out anywhere → merge-back takes the free-ref push path.
  git(base, ['branch', 'develop']);
  // Feature worktree forked from main (baseBranch=main), one commit ahead.
  const feature = path.join(root, 'repo-feature');
  git(base, ['worktree', 'add', '-b', 'feature', feature]);
  fs.writeFileSync(path.join(feature, 'f.txt'), 'f1');
  git(feature, ['add', 'f.txt']);
  git(feature, ['commit', '-m', 'f1']);
  return { root, base, feature };
}

function seed(userDataDir: string, base: string, feature: string) {
  const projects = [
    { id: BASE_ID, name: 'Target Base', cwd: base, connection: { type: 'local' }, maxTabs: 5 },
    {
      id: SUB_ID, name: 'Target Base', cwd: feature, connection: { type: 'local' }, maxTabs: 5,
      parentProjectId: BASE_ID, worktreeBranch: 'feature', baseBranch: 'main',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

async function openCloseMenu(page: Page, item: 'Finish' | 'Abandon') {
  await page.locator('.sidebar-item.worktree-child', { hasText: 'feature' }).click({ button: 'right' });
  await page.locator('.context-menu').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('.context-menu-item', { hasText: item }).click();
}

test.describe('finish target selector', () => {
  let userDataDir: string;
  let root: string;
  let base: string;
  let feature: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ftgt-ud-'));
    ({ root, base, feature } = makeRepo());
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

  test('selecting a non-default target ff-pushes into that branch, not baseBranch', async () => {
    const featureTip = git(feature, ['rev-parse', 'HEAD']).trim();
    const mainBefore = git(base, ['rev-parse', 'main']).trim();

    await openCloseMenu(page, 'Finish');

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    // The target selector lists the parent's branches (default = baseBranch main);
    // pick develop.
    await popup.locator('.worktree-select').selectOption('develop');
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    // Worktree gone; develop fast-forwarded to the feature tip; main untouched.
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(0, { timeout: 8_000 });
    expect(git(base, ['rev-parse', 'develop']).trim()).toBe(featureTip);
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(mainBefore);
    expect(fs.existsSync(feature)).toBe(false);
  });
});
