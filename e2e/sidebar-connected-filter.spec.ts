import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

const PROJECTS = {
  parent: 'filter-parent',
  child: 'filter-child',
  connected: 'filter-connected',
  disconnected: 'filter-disconnected',
  hiddenParent: 'filter-hidden-parent',
  hiddenChild: 'filter-hidden-child',
} as const;

function seedProjects(userDataDir: string) {
  const cwd = (name: string) => {
    const dir = path.join(userDataDir, name);
    fs.mkdirSync(dir);
    return dir;
  };
  const localProject = (id: string, name: string) => ({
    id,
    name,
    cwd: cwd(id),
    connection: { type: 'local' },
    maxTabs: 5,
  });

  const projects = [
    localProject(PROJECTS.parent, 'Alpha'),
    {
      ...localProject(PROJECTS.child, 'Alpha'),
      parentProjectId: PROJECTS.parent,
      worktreeBranch: 'feature/connected-child',
      baseBranch: 'main',
    },
    localProject(PROJECTS.connected, 'Bravo'),
    localProject(PROJECTS.disconnected, 'Charlie'),
    localProject(PROJECTS.hiddenParent, 'Delta'),
    {
      ...localProject(PROJECTS.hiddenChild, 'Delta'),
      parentProjectId: PROJECTS.hiddenParent,
      worktreeBranch: 'feature/disconnected-child',
      baseBranch: 'main',
    },
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');
}

async function connectProject(page: Page, label: string) {
  await page.locator('.sidebar-item', { hasText: label }).click();
  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.sidebar-item.active .status-dot.alive')).toBeVisible({ timeout: 8_000 });
}

test.describe('sidebar connected-only filter', () => {
  let userDataDir: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-filter-e2e-'));
    seedProjects(userDataDir);
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
  });

  test('filters standalone and worktree groups without changing active content or real order', async () => {
    await connectProject(page, 'feature/connected-child');
    await connectProject(page, 'Bravo');

    await page.locator('.sidebar-item', { hasText: 'Charlie' }).click();
    await expect(page.locator('.connect-prompt')).toBeVisible();
    const tabCount = await page.locator('.tab-bar .tab').count();

    await page.keyboard.press(`${modifier}+\\`);

    const filterButton = page.locator('.sidebar-header-actions .sidebar-btn').nth(2);
    await expect(filterButton).toHaveAttribute('aria-pressed', 'true');
    await expect(filterButton).toHaveAttribute('aria-label', 'Show all projects');
    await expect(page.locator('.sidebar-item')).toHaveCount(3);
    await expect(page.locator('.sidebar-item').nth(0)).toContainText('Alpha');
    await expect(page.locator('.sidebar-item').nth(1)).toContainText('feature/connected-child');
    await expect(page.locator('.sidebar-item').nth(2)).toContainText('Bravo');
    await expect(page.locator('.sidebar-item', { hasText: 'Charlie' })).toHaveCount(0);
    await expect(page.locator('.sidebar-item', { hasText: 'Delta' })).toHaveCount(0);

    // The hidden active project stays active: its right-side connect prompt remains,
    // and no visible row is marked active. The shortcut also must not open Split Right.
    await expect(page.locator('.connect-prompt')).toBeVisible();
    await expect(page.locator('.sidebar-item.active')).toHaveCount(0);
    await expect(page.locator('.tab-bar .tab')).toHaveCount(tabCount);

    // Previous moves from hidden Charlie to the nearest visible real index (Bravo).
    await page.keyboard.press(`${modifier}+ArrowUp`);
    await expect(page.locator('.sidebar-item.active')).toContainText('Bravo');
    await expect(page.locator('.terminal-container:visible')).toBeVisible({ timeout: 5_000 });

    // Bravo is the final visible row, so next is a no-op and does not wrap.
    await page.keyboard.press(`${modifier}+ArrowDown`);
    await expect(page.locator('.sidebar-item.active')).toContainText('Bravo');

    await page.keyboard.press(`${modifier}+\\`);
    await expect(filterButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.sidebar-item')).toHaveCount(6);
    await expect(page.locator('.sidebar-item').nth(3)).toContainText('Charlie');
    await expect(page.locator('.sidebar-item').nth(4)).toContainText('Delta');
  });

  test('custom shortcut replaces the default connected-filter binding', async () => {
    const filterButton = page.locator('.sidebar-header-actions .sidebar-btn').nth(2);
    await page.keyboard.press(`${modifier}+,`);
    await page.locator('.settings-tab', { hasText: 'Shortcuts' }).click();

    const row = page.locator('.settings-group', { hasText: 'Toggle Connected Filter' });
    await row.locator('.keybinding-btn').click();
    await page.keyboard.press(`${modifier}+e`);
    await page.locator('.project-edit-footer .conn-btn-next', { hasText: 'Save' }).click();

    await page.keyboard.press(`${modifier}+\\`);
    await expect(filterButton).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press(`${modifier}+e`);
    await expect(filterButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('mouse activation of every header action preserves terminal focus', async () => {
    await connectProject(page, 'Bravo');
    const terminalInput = page.locator('.terminal-container:visible .xterm-helper-textarea');
    const actions = page.locator('.sidebar-header-actions .sidebar-btn');
    await terminalInput.focus();
    await expect(terminalInput).toBeFocused();

    await actions.nth(0).click();
    await expect(terminalInput).toBeFocused();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sidebar-header-actions'))).toBe(false);
    await page.keyboard.press('Escape');

    await actions.nth(1).click();
    await expect(page.locator('.folder-picker-overlay')).toBeVisible();
    await expect(terminalInput).toBeFocused();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sidebar-header-actions'))).toBe(false);
    await page.locator('.folder-picker .conn-btn-cancel').click();
    await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();
    await terminalInput.focus();

    await actions.nth(2).click();
    await expect(terminalInput).toBeFocused();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sidebar-header-actions'))).toBe(false);
  });
});
