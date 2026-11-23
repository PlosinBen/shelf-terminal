import { openAgentTab, sendAgentPrompt } from './helpers';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_MUTATION } from '../src/shared/project-mutations';
import { IPC } from '../src/shared/ipc-channels';
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

  test('parent removal confirms children, removes the whole group and preserves Git worktrees', async () => {
    await connectMain();
    await expect(rows()).toHaveCount(1);
    const projects = await page.evaluate(() => window.shelfApi.project.getAll());
    const registeredChild = projects.find(project => project.parentProjectId === 'base')!;
    // Include child-owned Shelf data, so removal proves more than hiding sidebar rows.
    const childStorage = path.join(userData, 'projects', registeredChild.id);
    fs.mkdirSync(childStorage, { recursive: true });
    fs.writeFileSync(path.join(childStorage, 'removal-marker'), 'child data');
    const gitBefore = git(base, 'worktree', 'list', '--porcelain');
    await rows().first().click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: /^Connect$/ }).click();
    await openAgentTab(page);
    await sendAgentPrompt(page, 'hello');
    const historyCount = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('shelf-agent-history');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const request = db.transaction('messages').objectStore('messages').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    });
    await expect.poll(historyCount, { timeout: 10_000 }).toBeGreaterThan(0);
    const remove = async () => {
      await page.locator('.sidebar-item').filter({ hasText: 'Scan Base' }).first().click({ button: 'right' });
      await page.locator('.context-menu-item', { hasText: /^Remove$/ }).click();
    };
    await remove();
    const dialog = page.locator('.worktree-dialog');
    await expect(dialog).toContainText('external');
    await expect(dialog).toContainText(registeredChild.cwd);
    await expect(dialog).toContainText('conversation history');
    await expect(dialog).toContainText('Git worktree files and branches will be kept');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => window.shelfApi.project.getAll())).toHaveLength(2);
    expect(fs.existsSync(childStorage)).toBe(true);
    expect(await historyCount()).toBeGreaterThan(0);
    await remove();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.sidebar-item')).toHaveCount(0);
    await expect.poll(() => fs.existsSync(childStorage)).toBe(false);
    await expect.poll(historyCount).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'projects.json'), 'utf8')).projects).toEqual([]);
    expect(git(base, 'worktree', 'list', '--porcelain')).toBe(gitBefore);
    expect(fs.existsSync(child)).toBe(true);
    await app.close();
    await launch();
    await expect(page.locator('.sidebar-item')).toHaveCount(0);
  });

  test('connect scan detects orphan registrations and rescan retries after cancellation', async () => {
    const [main] = await page.evaluate(() => window.shelfApi.project.getAll());
    await app.close();
    const old = { ...main, id: 'orphan', parentProjectId: 'removed', cwd: fs.realpathSync(child), agentViews: {} };
    const second = { ...old, id: 'unregistered', cwd: path.join(root, 'absent') };
    const configPath = path.join(userData, 'projects.json');
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 4, projects: [main, old, second] }));
    for (const { id } of [old, second]) fs.mkdirSync(path.join(userData, 'projects', id), { recursive: true });
    const before = git(base, 'worktree', 'list', '--porcelain');
    await launch();
    await app.evaluate(({ dialog }) => {
      (globalThis as any).orphanPrompts = 0;
      dialog.showMessageBox = async (_window, options) => {
        if (options.title !== 'Remove orphan Shelf projects?') throw new Error('Unexpected dialog: ' + options.title);
        return { response: ++(globalThis as any).orphanPrompts === 1 ? 1 : 0, checkboxChecked: false };
      };
    });
    await connectMain();
    await expect.poll(() => app.evaluate(() => (globalThis as any).orphanPrompts)).toBe(1);
    const warning = page.getByRole('button', { name: 'Worktree scan failed' });
    await warning.click();
    const rescan = page.getByRole('button', { name: 'Rescan project worktrees' }).first();
    expect((await page.evaluate(() => window.shelfApi.project.getAll())).map(project => project.id)).toContain(old.id);
    await rescan.click();
    await expect(warning).toHaveCount(0);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')).projects;
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ parentProjectId: main.id, cwd: old.cwd });
    expect(saved[1].id).not.toBe(old.id);
    for (const { id } of [old, second]) expect(fs.existsSync(path.join(userData, 'projects', id))).toBe(false);
    expect(git(base, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  test('explains duplicate main projects and preserves existing worktrees on rescan', async () => {
    const [main] = await page.evaluate(() => window.shelfApi.project.getAll());
    const other = { ...main, id: 'other-main', agentViews: {} };
    // Git reports canonical checkout paths; macOS tmpdir may use the /var alias.
    const existing = { ...other, id: 'existing-child', cwd: fs.realpathSync(child), parentProjectId: other.id,
      worktreeBranch: 'external', baseBranch: 'main' };
    await app.close();
    fs.writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({
      schemaVersion: 4, projects: [main, other, existing],
    }));
    const gitBefore = git(base, 'worktree', 'list', '--porcelain');
    await launch();
    await connectMain();
    const trigger = page.getByRole('button', { name: 'Worktree scan failed' });
    await trigger.hover();
    await expect(page.locator('.worktree-scan-popover')).toBeVisible();
    const warning = page.locator('.worktree-scan-popover');
    await expect(warning).toContainText('Duplicate main projects');
    const anchor = await trigger.boundingBox();
    const panel = await warning.boundingBox();
    expect(panel!.x).toBeCloseTo(anchor!.x + anchor!.width + 8, 0);
    await warning.hover();
    // Wait beyond the dismissal delay to prove moving into the panel cancels it.
    await page.waitForTimeout(450);
    await expect(warning).toBeVisible();
    await page.mouse.move(790, 10);
    await expect(warning).toHaveCount(0);
    await trigger.focus();
    await expect(warning).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(warning.getByRole('button', { name: 'Rescan project worktrees' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(warning).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(warning).toBeVisible();
    await page.mouse.click(790, 10);
    await expect(warning).toHaveCount(0);
    await trigger.hover();
    await expect(warning).toBeVisible();
    // A sidebar warning near the bottom must not put Close outside the viewport.
    await page.getByRole('button', { name: 'Worktree scan failed' }).evaluate(button => {
      const host = button.parentElement!;
      host.style.position = 'fixed';
      host.style.bottom = '60px';
      host.style.left = '20px';
      host.style.zIndex = '100';
    });
    const close = warning.getByRole('button', { name: 'Close', exact: true });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(warning).toHaveCount(0);
    await page.getByRole('button', { name: 'Worktree scan failed' }).click();
    await expect(warning).toContainText('Duplicate main projects');
    const testWindow = await app.browserWindow(page);
    await testWindow.evaluate(browserWindow => {
      browserWindow.setMinimumSize(0, 0);
      browserWindow.setContentSize(800, 250);
    });
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(250);
    await trigger.hover();
    await warning.hover();
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(warning.getByRole('button', { name: 'Rescan project worktrees' })).toBeInViewport({ ratio: 1 });
    const details = warning.locator(':scope > span');
    expect(await details.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await details.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await close.click();
    await expect(warning).toHaveCount(0);
    await page.getByRole('button', { name: 'Worktree scan failed' }).click();
    for (const detail of ['Scan Base', 'ID: base', 'ID: other-main', 'ID: existing-child', base, child,
      'No scan updates were saved', 'Rescanning will fail again']) {
      await expect(warning).toContainText(detail);
    }
    await warning.getByRole('button', { name: 'Rescan project worktrees' }).click();
    await expect(warning.getByRole('button', { name: 'Rescan project worktrees' })).toBeEnabled();
    await page.waitForTimeout(450);
    await expect(warning).toContainText('Duplicate main projects');
    await expect(rows()).toHaveCount(1);
    const saved = await page.evaluate(() => window.shelfApi.project.getAll());
    expect(saved).toHaveLength(3);
    expect(saved.find(project => project.id === other.id)).toEqual(other);
    expect(saved.find(project => project.id === existing.id)).toEqual(existing);
    expect(git(base, 'worktree', 'list', '--porcelain')).toBe(gitBefore);
  });

  test('discovers external worktrees without focus, tabs or inherited sessions; persists missing and restores', async () => {
    await connectMain();
    await expect(rows()).toHaveCount(1);
    await expect(page.locator('.sidebar-item.active')).toContainText('Scan Base');
    const saved = await page.evaluate(() => window.shelfApi.project.getAll());
    const added = saved.find(p => p.parentProjectId === 'base')!;
    expect(added.defaultTabs).toEqual([{ name: 'Terminal' }]);
    expect(added.agentViews).toEqual({});
    await rows().click();
    await expect(page.locator('.connect-prompt')).toBeVisible();
    await page.locator('.connect-prompt').click();
    git(base, 'worktree', 'remove', '--force', child);
    await reconnectMain();
    await expect(rows()).toHaveClass(/worktree-missing/);
    await rows().click();
    await expect(page.locator('.worktree-unavailable')).toBeVisible();
    await expect(page.locator('.tab-add')).toBeDisabled();
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
  for (const kind of ['agent', 'web']) {
    test(`connect with only ${kind} tabs triggers discovery`, async () => {
      await page.evaluate(async ({ kind, mutation }) => {
        const project = (await window.shelfApi.project.getAll())[0];
        await window.shelfApi.project.update(project.id, { kind: mutation, edits: [{ field: 'defaultTabs', before: project.defaultTabs, value: kind === 'agent'
          ? [{ name: 'Agent', kind: 'agent', provider: 'claude' }]
          : [{ name: 'Web', kind: 'web', url: 'about:blank' }] }] });
      }, { kind, mutation: PROJECT_MUTATION.EDIT });
      await page.reload(); await page.waitForSelector('.app'); await connectMain();
      await expect(rows()).toHaveCount(1);
      await expect(page.locator('.sidebar-item.active')).toContainText('Scan Base');
      await rows().click();
      await expect(page.locator('.connect-prompt')).toBeVisible();
    });
  }

  test('ordinary non-Git directories skip scanning without a warning', async () => {
    fs.rmSync(path.join(base, '.git'), { recursive: true, force: true });
    await connectMain();
    const result = await page.evaluate(() => window.shelfApi.worktree.reconcile('base'));
    expect(result.outcome).toBe('skipped');
    await expect(page.getByRole('button', { name: 'Worktree scan failed' })).toHaveCount(0);
    await expect(rows()).toHaveCount(0);
  });

  test('rescans successfully after the first target probe failed', async () => {
    // Hold the first real scan until Connect has succeeded. Moving cwd before
    // Connect races startup directory validation and can disable Connect without
    // ever exercising the target-probe recovery this test protects.
    await app.evaluate(({ ipcMain }, channel) => {
      const original = (ipcMain as any)._invokeHandlers.get(channel);
      let first = true;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, projectId) => {
        if (first) {
          first = false;
          await new Promise<void>(resolve => { (globalThis as any).__releaseFirstWorktreeProbe = resolve; });
        }
        return original(event, projectId);
      });
    }, IPC.WORKTREE_RECONCILE);
    await connectMain();
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releaseFirstWorktreeProbe)).toBe('function');
    const moved = base + '-moved';
    fs.renameSync(base, moved);
    await app.evaluate(() => (globalThis as any).__releaseFirstWorktreeProbe());
    await expect(page.getByRole('button', { name: 'Worktree scan failed' })).toBeVisible();
    await page.getByRole('button', { name: 'Worktree scan failed' }).click();
    await expect(page.locator('.worktree-scan-popover')).toContainText('Cannot inspect target');
    await expect(rows()).toHaveCount(0);
    fs.renameSync(moved, base);
    await page.locator('.worktree-scan-popover').getByRole('button', { name: 'Rescan project worktrees' }).click();
    await expect(rows()).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Worktree scan failed' })).toHaveCount(0);
  });

});
