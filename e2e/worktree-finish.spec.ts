import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Finish worktree E2E — the user-initiated finish gate (#lifecycle).
 *
 * The worktree child's sidebar right-click menu → "Finish" opens the confirm
 * popup; on approve the renderer runs lock+ff merge-back → teardown → delete
 * branch. Base sits on `main` (topology b), so the ff lands via the base-tree
 * merge --ff-only path. Success = the worktree sub-project disappears.
 */

const BASE_ID = 'wt-finish-base';
const SUB_ID = 'wt-finish-sub';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV as NodeJS.ProcessEnv }).toString();
}

function makeRepoWithWorktree(): { root: string; base: string; feature: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wtf-'));
  const base = path.join(root, 'repo');
  fs.mkdirSync(base);
  git(base, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(base, 'a.txt'), 'c1');
  git(base, ['add', 'a.txt']);
  git(base, ['commit', '-m', 'c1']);
  const feature = path.join(root, 'repo-feature');
  git(base, ['worktree', 'add', '-b', 'feature', feature]);
  fs.writeFileSync(path.join(feature, 'f.txt'), 'f1');
  git(feature, ['add', 'f.txt']);
  git(feature, ['commit', '-m', 'f1']);
  return { root, base, feature };
}

function seed(userDataDir: string, base: string, feature: string) {
  const projects = [
    { id: BASE_ID, name: 'Finish Base', cwd: base, connection: { type: 'local' }, maxTabs: 5 },
    {
      id: SUB_ID, name: 'Finish Base', cwd: feature, connection: { type: 'local' }, maxTabs: 5,
      parentProjectId: BASE_ID, worktreeBranch: 'feature', baseBranch: 'main',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

/** Right-click the worktree child row and click a menu item ("Finish" / "Abandon"). */
async function openCloseMenu(page: Page, item: 'Finish' | 'Abandon') {
  const subItem = page.locator('.sidebar-item.worktree-child', { hasText: 'feature' });
  await subItem.click({ button: 'right' });
  await page.locator('.context-menu').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('.context-menu-item', { hasText: item }).click();
}

test.describe('finish worktree gate', () => {
  let userDataDir: string;
  let root: string;
  let base: string;
  let feature: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wtf-ud-'));
    ({ root, base, feature } = makeRepoWithWorktree());
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

  test('approve fast-forwards base, removes the worktree, deletes the branch', async () => {
    const featureTip = git(feature, ['rev-parse', 'HEAD']).trim();

    await openCloseMenu(page, 'Finish');

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup).toContainText('feature');
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    // The worktree sub-project disappeared (success = disappearance).
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(0, { timeout: 8_000 });
    // base `main` fast-forwarded to the feature tip.
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(featureTip);
    // The worktree dir is gone and the branch was deleted.
    expect(fs.existsSync(feature)).toBe(false);
    expect(git(base, ['branch', '--list', 'feature']).trim()).toBe('');
  });

  test('unchecking "delete branch" keeps the branch after finish', async () => {
    await openCloseMenu(page, 'Finish');

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.worktree-checkbox input[type="checkbox"]').uncheck();
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(0, { timeout: 8_000 });
    // Merged + worktree gone, but the branch was preserved.
    expect(fs.existsSync(feature)).toBe(false);
    expect(git(base, ['branch', '--list', 'feature']).trim()).toContain('feature');
  });

  test('cancel merges nothing and keeps the worktree', async () => {
    const mainBefore = git(base, ['rev-parse', 'main']).trim();

    await openCloseMenu(page, 'Finish');

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.conn-btn-cancel').click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    // Nothing merged/removed.
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(mainBefore);
    expect(fs.existsSync(feature)).toBe(true);
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(1);
  });
});
