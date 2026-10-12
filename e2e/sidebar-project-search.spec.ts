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

function seedProjects(userDataDir: string) {
  const cwd = (name: string) => {
    const dir = path.join(userDataDir, name);
    fs.mkdirSync(dir);
    return dir;
  };
  const project = (id: string, name: string) => ({
    id,
    name,
    cwd: cwd(id),
    connection: { type: 'local' },
    maxTabs: 5,
  });

  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([
    project('search-alpha', 'Alpha'),
    {
      ...project('search-child', 'Hidden Child Name'),
      parentProjectId: 'search-alpha',
      worktreeBranch: 'feature/project-search',
      baseBranch: 'main',
    },
    project('search-alpine', 'Alpine'),
    project('search-bravo', 'Bravo'),
  ]), 'utf-8');
}

test.describe('sidebar project search', () => {
  let userDataDir: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-project-search-e2e-'));
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

  test('locates displayed labels without filtering and activates only on Enter', async () => {
    const rows = page.locator('.sidebar-item');
    await rows.filter({ hasText: 'Bravo' }).click();
    await page.locator('.connect-prompt').click();
    const terminalInput = page.locator('.terminal-container:visible .xterm-helper-textarea');
    await expect(terminalInput).toBeFocused({ timeout: 8_000 });

    const searchButton = page.getByRole('button', { name: 'Search projects' });
    await searchButton.click();
    const input = page.getByRole('textbox', { name: 'Search projects' });
    await expect(input).toBeFocused();
    await expect(searchButton).toHaveAttribute('aria-pressed', 'true');

    await input.fill('al');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('.sidebar-item.project-search-match')).toHaveCount(2);
    await expect(page.locator('.sidebar-item.project-search-candidate')).toContainText('Alpha');
    await expect(page.locator('.sidebar-item.active')).toContainText('Bravo');

    await input.press('ArrowDown');
    await expect(page.locator('.sidebar-item.project-search-candidate')).toContainText('Alpine');
    await expect(page.locator('.sidebar-item.active')).toContainText('Bravo');

    await input.press('Enter');
    await expect(page.locator('.sidebar-project-search-row')).toHaveCount(0);
    await expect(page.locator('.sidebar-item.active')).toContainText('Alpine');
    await expect(page.locator('.connect-prompt')).toBeFocused();
  });

  test('searches worktrees by displayed branch and restores focus when cancelled', async () => {
    await page.locator('.sidebar-item', { hasText: 'Bravo' }).click();
    await page.locator('.connect-prompt').click();
    const terminalInput = page.locator('.terminal-container:visible .xterm-helper-textarea');
    await expect(terminalInput).toBeFocused({ timeout: 8_000 });

    await page.getByRole('button', { name: 'Search projects' }).click();
    const input = page.getByRole('textbox', { name: 'Search projects' });
    await input.fill('project-search');
    await expect(page.locator('.sidebar-item.project-search-match')).toHaveCount(1);
    await expect(page.locator('.sidebar-item.project-search-candidate')).toContainText('feature/project-search');

    const filterButton = page.getByRole('button', { name: 'Show connected only' });
    await filterButton.click();
    await expect(page.locator('.sidebar-item')).toHaveCount(1);
    await expect(page.locator('.sidebar-item.project-search-match')).toHaveCount(0);
    await expect(input).toBeFocused();
    await page.getByRole('button', { name: 'Show all projects' }).click();
    await expect(page.locator('.sidebar-item')).toHaveCount(4);
    await expect(page.locator('.sidebar-item.project-search-match')).toHaveCount(1);

    await input.fill('Hidden Child Name');
    await expect(page.locator('.sidebar-item.project-search-match')).toHaveCount(0);
    await input.press('Escape');
    await expect(page.locator('.sidebar-project-search-row')).toHaveCount(0);
    await expect(terminalInput).toBeFocused();

    const searchButton = page.getByRole('button', { name: 'Search projects' });
    await searchButton.click();
    await expect(input).toBeFocused();
    await searchButton.click();
    await expect(page.locator('.sidebar-project-search-row')).toHaveCount(0);
    await expect(terminalInput).toBeFocused();

    await searchButton.click();
    await input.fill('Bravo');
    await input.press('Enter');
    await expect(page.locator('.sidebar-project-search-row')).toHaveCount(0);
    await expect(page.locator('.sidebar-item.active')).toContainText('Bravo');
    await expect(terminalInput).toBeFocused();
  });
});
