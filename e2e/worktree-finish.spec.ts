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
    {
      id: BASE_ID, name: 'Finish Base', cwd: base, connection: { type: 'local' }, maxTabs: 5,
      featureNoteDir: 'notes/future',
    },
    {
      id: SUB_ID, name: 'Finish Base', cwd: feature, connection: { type: 'local' }, maxTabs: 5,
      parentProjectId: BASE_ID, worktreeBranch: 'feature', baseBranch: 'main',
      featureNoteDir: '.agent/features',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

function writeFeatureNote(cwd: string, rel: string, body: string) {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
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

  test.beforeEach(async ({}, testInfo) => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wtf-ud-'));
    ({ root, base, feature } = makeRepoWithWorktree());
    seed(userDataDir, base, feature);
    if (testInfo.title.includes('unconfigured')) {
      const configPath = path.join(userDataDir, 'projects.json');
      const projects = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      delete projects[1].featureNoteDir;
      fs.writeFileSync(configPath, JSON.stringify(projects));
    }
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
    await expect(popup.getByLabel('Only merge')).not.toBeChecked();
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    // The worktree sub-project disappeared (success = disappearance).
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(0, { timeout: 8_000 });
    await expect(page.locator('.sidebar-item.active', { hasText: 'Finish Base' })).toHaveCount(1);
    const banner = page.locator('.project-notice-banner');
    await expect(banner).toContainText('Merged feature → main and closed the worktree');
    await banner.locator('.project-notice-dismiss').click();
    await expect(banner).toHaveCount(0);
    // base `main` fast-forwarded to the feature tip.
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(featureTip);
    // The worktree dir is gone and the branch was deleted.
    expect(fs.existsSync(feature)).toBe(false);
    expect(git(base, ['branch', '--list', 'feature']).trim()).toBe('');
  });

  test('checking Only merge only merges and preserves the worktree environment', async () => {
    const rel = '.agent/features/carried.md';
    const body = '# Keep this note in the worktree\n';
    fs.writeFileSync(path.join(feature, '.gitignore'), '.agent/features/\n', 'utf-8');
    git(feature, ['add', '.gitignore']);
    git(feature, ['commit', '-m', 'ignore feature notes']);
    writeFeatureNote(feature, rel, body);
    const featureTip = git(feature, ['rev-parse', 'HEAD']).trim();

    const child = page.locator('.sidebar-item.worktree-child', { hasText: 'feature' });
    await child.click();
    await page.locator('.connect-prompt').click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
    const terminal = await page.locator('.terminal-container:visible').elementHandle();
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
    const textarea = page.locator('.agent-textarea:visible');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('merge-only-conversation');
    await textarea.press('Enter');
    await expect(page.locator('.agent-msg-reply:visible')).toContainText('merge-only-conversation');
    const tabLabels = await page.locator('.tab-bar .tab-label').allTextContents();

    await openCloseMenu(page, 'Finish');

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.worktree-checkbox input[type="checkbox"]').check();
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });

    await expect(child).toHaveClass(/active/);
    await expect(page.locator('.project-notice-banner > span')).toHaveText('Merged feature → main');
    await expect(page.locator('.tab-bar .tab-label')).toHaveText(tabLabels);
    await expect(page.locator('.agent-msg-reply:visible')).toContainText('merge-only-conversation');
    await expect(textarea).toBeVisible();
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(featureTip);
    expect(fs.existsSync(feature)).toBe(true);
    expect(git(base, ['branch', '--list', 'feature']).trim()).toContain('feature');
    expect(fs.readFileSync(path.join(feature, rel), 'utf-8')).toBe(body);
    expect(fs.existsSync(path.join(base, rel))).toBe(false);
    // The terminal view is retained, rather than disposed and recreated.
    await page.locator('.tab-bar .tab').first().click();
    await expect(page.locator('.terminal-container:visible')).toBeVisible();
    expect(await terminal!.evaluate((element) => element.isConnected)).toBe(true);
    expect(git(feature, ['status', '--porcelain']).trim()).toBe('');
  });

  test('merge-only keeps the current focus when finishing a background worktree', async () => {
    const featureTip = git(feature, ['rev-parse', 'HEAD']).trim();
    const baseProject = page.locator('.sidebar-item', { hasText: 'Finish Base' }).first();
    await baseProject.click();
    await openCloseMenu(page, 'Finish');
    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible();
    // Opening a sidebar context menu focuses its owner. Switch project using
    // the existing keyboard shortcut while the gate remains open.
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+ArrowUp`);
    await expect(baseProject).toHaveClass(/active/);
    await popup.locator('.worktree-checkbox input[type="checkbox"]').check();
    await popup.locator('.conn-btn-next').click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });
    await expect(baseProject).toHaveClass(/active/);
    await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(1);
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(featureTip);
    expect(fs.existsSync(feature)).toBe(true);
    await page.locator('.sidebar-item.worktree-child', { hasText: 'feature' }).click();
    await expect(page.locator('.connect-prompt')).toBeVisible();
    await expect(page.locator('.project-notice-banner > span')).toHaveText('Merged feature → main');
  });

  for (const retry of ['merge-only', 'remove-note'] as const) {
    test(`remaining notes block before merge; retry with ${retry}`, async () => {
      const rel = '.agent/features/carried.md';
      fs.writeFileSync(path.join(feature, '.gitignore'), '.agent/\n');
      git(feature, ['add', '.gitignore']);
      git(feature, ['commit', '-m', 'ignore notes']);
      writeFeatureNote(feature, rel, '---\nstatus: pending\n---\nKeep context');
      const before = git(base, ['rev-parse', 'main']).trim();
      const tip = git(feature, ['rev-parse', 'HEAD']).trim();
      expect(git(feature, ['status', '--porcelain']).trim()).toBe('');
      await openCloseMenu(page, 'Finish');
      const popup = page.locator('.worktree-dialog');
      await popup.getByRole('button', { name: 'Finish', exact: true }).click();
      await expect(popup.locator('.worktree-error')).toContainText(rel);
      await expect(popup.locator('.worktree-error')).toContainText('No merge or cleanup');
      await expect(popup.getByRole('button', { name: 'Send to agent' })).toBeDisabled();
      expect(git(base, ['rev-parse', 'main']).trim()).toBe(before);
      expect(fs.existsSync(path.join(feature, rel))).toBe(true);
      expect(fs.existsSync(path.join(base, rel))).toBe(false);
      expect(git(base, ['branch', '--list', 'feature']).trim()).toContain('feature');
      await expect(page.locator('.sidebar-item.worktree-child')).toHaveCount(1);
      if (retry === 'merge-only') {
        await popup.getByLabel('Only merge').check();
        await expect(popup.locator('.worktree-error')).toHaveCount(0);
      } else {
        fs.unlinkSync(path.join(feature, rel));
      }
      await popup.getByRole('button', { name: 'Finish', exact: true }).click();
      await expect(popup).not.toBeVisible({ timeout: 8_000 });
      expect(git(base, ['rev-parse', 'main']).trim()).toBe(tip);
      expect(fs.existsSync(feature)).toBe(retry === 'merge-only');
    });
  }

  test('note listing failure blocks cleanup but allows Only merge', async () => {
    fs.writeFileSync(path.join(feature, '.gitignore'), '.agent/\n');
    git(feature, ['add', '.gitignore']);
    git(feature, ['commit', '-m', 'ignore notes']);
    fs.mkdirSync(path.join(feature, '.agent'));
    fs.writeFileSync(path.join(feature, '.agent/features'), 'not a directory');
    const before = git(base, ['rev-parse', 'main']).trim();
    await openCloseMenu(page, 'Finish');
    const popup = page.locator('.worktree-dialog');
    await popup.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(popup.locator('.worktree-error')).toContainText('Unable to access configured feature note directory');
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(before);
    expect(fs.existsSync(feature)).toBe(true);
    await popup.getByLabel('Only merge').check();
    await popup.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(popup).not.toBeVisible({ timeout: 8_000 });
    expect(git(base, ['rev-parse', 'main']).trim()).toBe(git(feature, ['rev-parse', 'HEAD']).trim());
  });

  for (const variant of ['index-only', 'unconfigured'] as const) {
    test(`finish accepts ${variant} note scope`, async () => {
      fs.writeFileSync(path.join(feature, '.gitignore'), '.agent/\n');
      git(feature, ['add', '.gitignore']);
      git(feature, ['commit', '-m', 'ignore notes']);
      writeFeatureNote(feature, `.agent/features/${variant === 'index-only' ? 'index' : 'outside-scope'}.md`, 'context');
      await openCloseMenu(page, 'Finish');
      const popup = page.locator('.worktree-dialog');
      await popup.getByRole('button', { name: 'Finish', exact: true }).click();
      await expect(popup).not.toBeVisible({ timeout: 8_000 });
      expect(fs.existsSync(feature)).toBe(false);
    });
  }

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

  for (const onlyMerge of [false, true]) {
    test(`modified tracked file blocks finish (onlyMerge=${onlyMerge})`, async () => {
      const mainBefore = git(base, ['rev-parse', 'main']).trim();
      fs.writeFileSync(path.join(feature, 'f.txt'), 'uncommitted edit');

      await openCloseMenu(page, 'Finish');

      const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
      await expect(popup).toBeVisible({ timeout: 5_000 });
      if (onlyMerge) await popup.getByLabel('Only merge').check();
      await popup.locator('.conn-btn-next').click();

      const err = popup.locator('.worktree-error');
      await expect(err).toContainText('git status --porcelain', { timeout: 8_000 });
      await expect(err).toContainText('f.txt');
      expect(git(base, ['rev-parse', 'main']).trim()).toBe(mainBefore);
      expect(fs.existsSync(feature)).toBe(true);
      expect(fs.readFileSync(path.join(feature, 'f.txt'), 'utf-8')).toBe('uncommitted edit');
      await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(1);
      await expect(page.locator('.project-notice-banner')).toHaveCount(0);
    });

    test(`untracked file blocks finish (onlyMerge=${onlyMerge})`, async () => {
      const mainBefore = git(base, ['rev-parse', 'main']).trim();
      fs.writeFileSync(path.join(feature, 'scratch.txt'), 'keep me');

      await openCloseMenu(page, 'Finish');

      const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
      await expect(popup).toBeVisible({ timeout: 5_000 });
      if (onlyMerge) await popup.getByLabel('Only merge').check();
      await popup.locator('.conn-btn-next').click();

      const err = popup.locator('.worktree-error');
      await expect(err).toContainText('git status --porcelain', { timeout: 8_000 });
      await expect(err).toContainText('scratch.txt');
      expect(git(base, ['rev-parse', 'main']).trim()).toBe(mainBefore);
      expect(fs.existsSync(feature)).toBe(true);
      expect(fs.readFileSync(path.join(feature, 'scratch.txt'), 'utf-8')).toBe('keep me');
      await expect(page.locator('.sidebar-item.worktree-child', { hasText: 'feature' })).toHaveCount(1);
      await expect(page.locator('.project-notice-banner')).toHaveCount(0);
    });

  }

  test('worktree agent proposal opens the Finish gate without merging', async () => {
    await page.locator('.sidebar-item.worktree-child', { hasText: 'feature' }).click();
    await page.locator('.connect-prompt').click();
    await page.locator('.tab-add').click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
    const textarea = page.locator('.agent-textarea:visible');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('delay:800|worktree_finish');
    await textarea.press('Enter');

    const baseProject = page.locator('.sidebar-item', { hasText: 'Finish Base' }).first();
    const childProject = page.locator('.sidebar-item.worktree-child', { hasText: 'feature' });
    await baseProject.click();
    await expect(baseProject).toHaveClass(/active/);

    const popup = page.locator('.worktree-dialog', { hasText: 'Finish Worktree' });
    await expect(popup).toBeVisible({ timeout: 8_000 });
    await expect(childProject).toHaveClass(/active/);
    await expect(popup.locator('.project-requester')).toHaveText('Requested by: feature');
    await popup.locator('.conn-btn-cancel').click();
    await expect(childProject).toHaveClass(/active/);
    expect(fs.existsSync(feature)).toBe(true);
  });
});
