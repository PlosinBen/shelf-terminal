import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env }).toString();
test.describe('worktree reconciliation', () => {
  let root: string, base: string, child: string, userData: string;
  let app: ElectronApplication, page: Page;
  const rows = () => page.locator('.sidebar-item.worktree-child');
  async function launch() {
    app = await electron.launch({ args: [path.join(__dirname, '..'), `--user-data-dir=${userData}`], env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string> });
    page = await app.firstWindow();
    await page.waitForSelector('.app');
  }
  async function connectMain() {
    await page.locator('.sidebar-item').filter({ hasText: 'Scan Base' }).first().click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: /^Connect$/ }).click();
  }
  async function reconnectMain() {
    await page.locator('.sidebar-item').filter({ hasText: 'Scan Base' }).first().click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: /^Disconnect$/ }).click();
    await connectMain();
  }
  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-reconcile-'));
    base = path.join(root, 'repo'); child = path.join(root, 'external'); userData = path.join(root, 'user');
    fs.mkdirSync(base); fs.mkdirSync(userData);
    git(base, 'init', '-b', 'main'); git(base, 'commit', '--allow-empty', '-m', 'initial');
    git(base, 'worktree', 'add', '-b', 'external', child);
    fs.writeFileSync(path.join(userData, 'projects.json'), JSON.stringify([{ id: 'base', name: 'Scan Base', cwd: base, connection: { type: 'local' }, maxTabs: 5, defaultTabs: [{ name: 'Inherited terminal' }], agentSessionIds: { fake: 'parent-session' } }]));
    await launch();
  });
  test.afterEach(async () => { await app?.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });

  test('discovers external worktrees without focus, tabs or inherited sessions; persists missing and restores', async () => {
    await connectMain();
    await expect(rows()).toHaveCount(1);
    await expect(page.locator('.sidebar-item.active')).toContainText('Scan Base');
    const saved = await page.evaluate(() => window.shelfApi.project.getAll());
    const added = saved.find(p => p.parentProjectId === 'base')!;
    expect(added.defaultTabs).toEqual([{ name: 'Inherited terminal' }]);
    expect(added.agentSessionIds).toEqual({});
    await rows().click();
    await expect(page.locator('.connect-prompt')).toBeVisible();
    await page.locator('.connect-prompt').click();
    git(base, 'worktree', 'remove', '--force', child);
    await reconnectMain();
    await expect(rows()).toHaveClass(/worktree-missing/);
    await rows().click();
    await expect(page.locator('.worktree-unavailable')).toBeVisible();
    await rows().click({ button: 'right' });
    await expect(page.locator('.context-menu')).toHaveCount(0);
    await expect(page.locator('.tab')).toHaveCount(0);
    await app.close(); await launch();
    await rows().click();
    await expect(page.locator('.worktree-unavailable')).toBeVisible();
    git(base, 'worktree', 'add', child, 'external');
    await page.getByRole('button', { name: 'Rescan project worktrees' }).click();
    await expect(page.locator('.connect-prompt')).toBeVisible();
    const restored = await page.evaluate(() => window.shelfApi.project.getAll());
    expect(restored.find(p => p.parentProjectId === 'base')?.id).toBe(added.id);
    await expect(rows()).toHaveCount(1);
    await expect(page.locator('.sidebar-item.active')).toContainText('external');
  });

  test('shows repo scan failure on main and Remove does not clean Git registrations', async () => {
    await connectMain(); await expect(rows()).toHaveCount(1);
    fs.rmSync(child, { recursive: true, force: true });
    await reconnectMain(); await expect(rows()).toHaveClass(/worktree-missing/);
    await rows().click();
    const moved = base + '-moved'; fs.renameSync(base, moved);
    await page.getByRole('button', { name: 'Rescan project worktrees' }).click();
    await expect(page.getByRole('button', { name: 'Worktree scan failed' })).toBeVisible();
    await page.getByRole('button', { name: 'Worktree scan failed' }).click();
    await expect(page.locator('.sidebar-item.active')).toContainText('external');
    await expect(page.locator('.worktree-scan-popover')).toBeVisible();
    fs.renameSync(moved, base);
    await page.locator('.worktree-scan-popover').getByRole('button', { name: 'Rescan project worktrees' }).click();
    await expect(page.getByRole('button', { name: 'Worktree scan failed' })).toHaveCount(0);
    const registration = git(base, 'worktree', 'list', '--porcelain');
    await page.locator('.worktree-unavailable').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Also delete worktree files')).toHaveCount(0);
    await page.locator('.worktree-dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(rows()).toHaveCount(0);
    expect(git(base, 'worktree', 'list', '--porcelain')).toBe(registration);
    await reconnectMain(); await expect(rows()).toHaveCount(0);
  });

  test('includes detached HEAD and updates the existing child label', async () => {
    git(child, 'checkout', '--detach');
    await connectMain();
    await expect(rows()).toContainText('external (detached)');
    const before = await page.evaluate(() => window.shelfApi.project.getAll());
    git(child, 'checkout', 'external');
    await reconnectMain();
    await expect(rows()).toHaveText('external');
    const after = await page.evaluate(() => window.shelfApi.project.getAll());
    expect(after.find(p => p.parentProjectId)?.id).toBe(before.find(p => p.parentProjectId)?.id);
  });
});
