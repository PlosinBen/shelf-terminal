import { test, expect, readActiveTerminalText } from './helpers';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Helper: open folder picker and go through connection step
async function openFolderPicker(page: any) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  const overlay = page.locator('.folder-picker-overlay');
  await expect(overlay).toBeVisible({ timeout: 5_000 });

  // Connection step: click Next (Local is default)
  const nextBtn = page.locator('.conn-btn-next');
  await expect(nextBtn).toBeVisible({ timeout: 3_000 });
  await nextBtn.click();

  // Now in browse step. setStep('browse') is synchronous but listDir is
  // async — on slow hosts a subsequent Cmd+Enter fires while currentPath
  // is still '', producing an empty-cwd project. Wait for the resolved
  // path to render before returning.
  const header = page.locator('.fp-header');
  await expect(header).toContainText('Open Project', { timeout: 5_000 });
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
}

/**
 * Per-test fixture means earlier tests in this file no longer leave a
 * project + terminal lying around — every test that needs them has to
 * build them itself. Idempotent: skips steps already done.
 */
async function ensureProjectWithTerminal(page: any) {
  // Close any stale folder picker first.
  if (await page.locator('.folder-picker-overlay').isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });
  }
  // Create project if sidebar is empty.
  if (await page.locator('.sidebar-item').count() === 0) {
    await openFolderPicker(page);
    await page.keyboard.press(`${modifier}+Enter`);
    await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });
  }
  // Open a terminal tab if none.
  if (await page.locator('.tab-bar .tab').count() === 0) {
    const prompt = page.locator('.connect-prompt');
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await prompt.click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  }
}

interface SeededProjectApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  targetDir: string;
  close(): Promise<void>;
}

function seededProject(id: string, name: string, cwd: string) {
  return {
    id,
    name,
    cwd,
    connection: { type: 'local' as const },
    maxTabs: 5,
  };
}

async function launchSeededProjectApp(duplicateCount = 1): Promise<SeededProjectApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-duplicate-project-e2e-'));
  const targetDir = fs.mkdtempSync(path.join(os.homedir(), 'shelf-duplicate-target-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-other-project-'));
  const projects = [
    seededProject('first-match', 'First Match', targetDir),
    ...(duplicateCount > 1
      ? [seededProject('second-match', 'Second Match', `${targetDir}${path.sep}`)]
      : []),
    seededProject('other-project', 'Other Project', otherDir),
  ];
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify(projects), 'utf-8');

  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 10_000 });

  return {
    app,
    page,
    userDataDir,
    targetDir,
    async close() {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    },
  };
}

async function selectSeededTarget(page: Page, targetDir: string) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });

  const targetName = path.basename(targetDir);
  const targetRow = page.locator('.folder-picker-item').filter({ hasText: targetName });
  await expect(targetRow).toHaveCount(1);
  await targetRow.click();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });
}

function persistedProjects(userDataDir: string): unknown[] {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8'));
}

test('open folder picker via sidebar button', async ({ shelfApp: { page } }) => {
  const addBtn = page.locator('.sidebar-btn', { hasText: '+' });
  await addBtn.click();

  const overlay = page.locator('.folder-picker-overlay');
  await expect(overlay).toBeVisible({ timeout: 5_000 });

  const header = page.locator('.fp-header');
  await expect(header).toContainText('New Project');
});

test('folder picker connection step shows Local by default', async ({ shelfApp: { page } }) => {
  if (!await page.locator('.folder-picker-overlay').isVisible()) {
    await page.locator('.sidebar-btn', { hasText: '+' }).click();
    await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  }

  const localBtn = page.locator('.conn-type-btn.active');
  await expect(localBtn).toContainText('Local');
});

test('folder picker shows home directory entries after Next', async ({ shelfApp: { page } }) => {
  // Close if open, then reopen with full flow
  const overlay = page.locator('.folder-picker-overlay');
  if (await overlay.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  }

  await openFolderPicker(page);

  const list = page.locator('.fp-browser-list');
  await expect(list).toBeVisible();

  const items = page.locator('.folder-picker-item');
  await expect(items.first()).toBeVisible({ timeout: 3_000 });
  const count = await items.count();
  expect(count).toBeGreaterThan(1);
});

test('folder picker keyboard navigation works', async ({ shelfApp: { page } }) => {
  if (await page.locator('.folder-picker-overlay').isVisible()) {
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();

  await openFolderPicker(page);

  await page.keyboard.press('ArrowDown');
  const selected = page.locator('.folder-picker-item.selected');
  await expect(selected).toBeVisible();
});

test('Tab in browse step does not leak focus to background', async ({ shelfApp: { page } }) => {
  if (await page.locator('.folder-picker-overlay').isVisible()) {
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();

  await openFolderPicker(page);

  // Browse step has no focusable inputs; Tab must stay trapped (not jump the
  // focus ring to a control behind the modal, e.g. a sidebar button).
  await page.keyboard.press('Tab');

  const leaked = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return false;
    return !el.closest('.folder-picker-overlay') && el.tagName !== 'BODY';
  });
  expect(leaked).toBe(false);
  // Picker is still open and usable.
  await expect(page.locator('.folder-picker-overlay')).toBeVisible();
});

test('select folder and create project', async ({ shelfApp: { page } }) => {
  if (await page.locator('.folder-picker-overlay').isVisible()) {
    await page.keyboard.press('Escape');
  }

  await openFolderPicker(page);

  // Press Cmd+Enter (macOS) / Ctrl+Enter to select current dir as project
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  // Project should appear in sidebar (count increases by 1)
  const sidebarItems = page.locator('.sidebar-item');
  await expect(sidebarItems).toHaveCount(1, { timeout: 5_000 });
});

test('project shows connect prompt before connecting', async ({ shelfApp: { page } }) => {
  // Need a project but no terminal yet — open folder picker manually.
  await openFolderPicker(page);
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
});

test('clicking connect prompt opens terminal', async ({ shelfApp: { page } }) => {
  await openFolderPicker(page);
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();

  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  const xtermScreen = page.locator('.xterm-screen:visible');
  await expect(xtermScreen).toBeVisible({ timeout: 10_000 });
});

test('Cmd+T adds another tab', async ({ shelfApp: { page } }) => {
  await ensureProjectWithTerminal(page);
  await page.keyboard.press(`${modifier}+t`);

  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
});

test('terminal spawns and shows output', async ({ shelfApp: { page } }) => {
  await ensureProjectWithTerminal(page);
  const terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });

  await page.waitForTimeout(2000);
  expect((await readActiveTerminalText(page)).length).toBeGreaterThan(0);
});

test('project shows green status dot', async ({ shelfApp: { page } }) => {
  await ensureProjectWithTerminal(page);
  const statusDot = page.locator('.sidebar-item .status-dot.alive').first();
  await expect(statusDot).toBeVisible({ timeout: 5_000 });
});

test('selecting a disconnected duplicate reopens and connects the existing project', async () => {
  const seeded = await launchSeededProjectApp();
  try {
    await seeded.page.locator('.sidebar-item', { hasText: 'Other Project' }).click();

    await selectSeededTarget(seeded.page, seeded.targetDir);

    await expect(seeded.page.locator('.sidebar-item.active')).toContainText('First Match');
    await expect(seeded.page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 8_000 });
    expect(persistedProjects(seeded.userDataDir)).toHaveLength(2);
  } finally {
    await seeded.close();
  }
});

test('selecting a connected duplicate preserves its existing tab without reconnecting', async () => {
  const seeded = await launchSeededProjectApp();
  try {
    await seeded.page.locator('.sidebar-item', { hasText: 'First Match' }).click();
    await seeded.page.locator('.connect-prompt').click();
    await expect(seeded.page.locator('.terminal-container:visible')).toBeVisible({ timeout: 8_000 });
    await seeded.page.locator('.terminal-container:visible').evaluate((element) => {
      element.setAttribute('data-existing-terminal', 'true');
    });
    await seeded.page.locator('.sidebar-item', { hasText: 'Other Project' }).click();

    await selectSeededTarget(seeded.page, seeded.targetDir);

    await expect(seeded.page.locator('.sidebar-item.active')).toContainText('First Match');
    await expect(seeded.page.locator('[data-existing-terminal="true"]:visible')).toBeVisible();
    await expect(seeded.page.locator('.tab-bar .tab')).toHaveCount(1);
    expect(persistedProjects(seeded.userDataDir)).toHaveLength(2);
  } finally {
    await seeded.close();
  }
});

test('selecting a legacy duplicate target reopens the first project in reconciled order', async () => {
  const seeded = await launchSeededProjectApp(2);
  try {
    await seeded.page.locator('.sidebar-item', { hasText: 'Other Project' }).click();

    await selectSeededTarget(seeded.page, seeded.targetDir);

    await expect(seeded.page.locator('.sidebar-item.active')).toContainText('First Match');
    await expect(seeded.page.locator('.sidebar-item', { hasText: 'First Match' }).locator('.status-dot')).toHaveClass(/alive/);
    await expect(seeded.page.locator('.sidebar-item', { hasText: 'Second Match' }).locator('.status-dot')).toHaveClass(/dead/);
    expect(persistedProjects(seeded.userDataDir)).toHaveLength(3);
  } finally {
    await seeded.close();
  }
});
