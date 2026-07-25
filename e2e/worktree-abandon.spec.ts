import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { openAgentTab, sendAgentPrompt } from './helpers';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * worktree_project_abandon E2E — the agent-driven abandon gate.
 *
 * Abandon = teardown → force-delete branch, NO merge-back: the base branch never
 * moves and the feature's unmerged commits are discarded (guarded by the popup's
 * loss warning). Self-close, driven by the sub-project's own agent tab.
 */

const BASE_ID = 'wt-abandon-base';
const SUB_ID = 'wt-abandon-sub';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV as NodeJS.ProcessEnv }).toString();
}

function makeRepoWithWorktree(): { root: string; base: string; feature: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wta-'));
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
    { id: BASE_ID, name: 'Abandon Base', cwd: base, connection: { type: 'local' }, maxTabs: 5 },
    {
      id: SUB_ID, name: 'Abandon Base', cwd: feature, connection: { type: 'local' }, maxTabs: 5,
      parentProjectId: BASE_ID, worktreeBranch: 'feature', baseBranch: 'main',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

async function openAgentInSub(page: Page) {
  const subItem = page.locator('.sidebar-item.worktree-child', { hasText: 'feature' });
  await subItem.click();
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 8_000 });
  await openAgentTab(page);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
}

test.describe('worktree_project_abandon gate', () => {
  let userDataDir: string;
  let root: string;
  let base: string;
  let feature: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wta-ud-'));
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

  test('approve removes the worktree + branch WITHOUT moving base', async () => {
    const mainBefore = git(base, ['rev-parse', 'main']).trim();

    await openAgentInSub(page);
    await sendAgentPrompt(page, 'apptool:worktree_project.abandon');

    const popup = page.locator('.worktree-dialog', { hasText: 'Abandon Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup).toContainText('permanently discards');
    await popup.locator('.conn-btn-danger').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    // Sub-project gone; base untouched; worktree + branch removed.
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(0, { timeout: 8_000 });
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(mainBefore); // base NOT moved
    expect(fs.existsSync(feature)).toBe(false);
    expect(git(base, ['branch', '--list', 'feature']).trim()).toBe('');
  });

  test('cancel keeps everything and reports closed:false', async () => {
    await openAgentInSub(page);
    await sendAgentPrompt(page, 'apptool:worktree_project.abandon');

    const popup = page.locator('.worktree-dialog', { hasText: 'Abandon Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.conn-btn-cancel').click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    expect(fs.existsSync(feature)).toBe(true);
    expect(git(base, ['branch', '--list', 'feature']).trim()).toContain('feature');
    await expect(page.locator('.agent-turn-response')).toContainText('"closed":false', { timeout: 8_000 });
  });
});
