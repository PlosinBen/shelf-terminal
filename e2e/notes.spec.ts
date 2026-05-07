import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Notes is a per-project panel, so we need a project on disk before launch.
// Each test gets a fresh userData with a single seeded project — this is
// closer to config-bootstrap.spec.ts than the worker-scoped fixture in
// helpers.ts because we need to inspect projects/<id>/notes/ on the
// filesystem after the test.

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const PROJECT_ID = 'test-project-notes';

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env } as Record<string, string>,
  });
}

function seedProject(userDataDir: string) {
  const project = {
    id: PROJECT_ID,
    name: 'Notes Test',
    cwd: os.homedir(),
    connection: { type: 'local' },
    maxTabs: 5,
  };
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([project]), 'utf-8');
}

async function openNotesPanel(page: Page) {
  const panel = page.locator('.notes-view');
  if (await panel.isVisible().catch(() => false)) return;
  const btn = page.locator('.right-tab-btn', { hasText: 'Notes' });
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await btn.click();
  await expect(panel).toBeVisible({ timeout: 3_000 });
}

test.describe('Notes panel', () => {
  let userDataDir: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-notes-e2e-'));
    seedProject(userDataDir);
    app = await launchApp(userDataDir);
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 10_000 });
    // Make sure the seeded project is the active one.
    await page.locator('.sidebar-item').first().click();
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('Notes button shows in right-side collapsed tabs', async () => {
    const btn = page.locator('.right-tab-btn', { hasText: 'Notes' });
    await expect(btn).toBeVisible({ timeout: 5_000 });
  });

  test('clicking Notes opens panel with empty state', async () => {
    await openNotesPanel(page);
    await expect(page.locator('.notes-title')).toContainText('Notes');
    await expect(page.locator('.notes-empty')).toContainText('No notes yet');
  });

  test('Cmd+N keybinding toggles panel', async () => {
    await page.keyboard.press(`${modifier}+n`);
    await expect(page.locator('.notes-view')).toBeVisible({ timeout: 3_000 });
    await page.keyboard.press(`${modifier}+n`);
    await expect(page.locator('.notes-view')).not.toBeVisible({ timeout: 3_000 });
  });

  test('+ button creates a new note and opens editor', async () => {
    await openNotesPanel(page);
    await page.locator('.notes-new-btn').click();

    // Editor is now visible — meta row + textarea.
    await expect(page.locator('.notes-title-input')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.notes-textarea')).toBeVisible();
  });

  test('typing # heading auto-derives title in list', async () => {
    await openNotesPanel(page);
    await page.locator('.notes-new-btn').click();
    const ta = page.locator('.notes-textarea');
    await ta.fill('# My First Note\n\nbody');
    // Title input should auto-fill from the heading.
    await expect(page.locator('.notes-title-input')).toHaveValue('My First Note', { timeout: 3_000 });

    // Wait for debounced auto-save (600ms) then go back and check list.
    await page.waitForTimeout(900);
    await page.locator('.notes-back').click();
    await expect(page.locator('.notes-list-title')).toContainText('My First Note');
  });

  test('manual title overrides auto-derived heading', async () => {
    await openNotesPanel(page);
    await page.locator('.notes-new-btn').click();

    const titleInput = page.locator('.notes-title-input');
    await titleInput.fill('Custom Title');

    // After manual input, heading changes shouldn't fight back.
    await page.locator('.notes-textarea').fill('# Different Heading\n\nbody');
    await expect(titleInput).toHaveValue('Custom Title');
  });

  test('Done checkbox flips note between Active and Done filter', async () => {
    await openNotesPanel(page);
    await page.locator('.notes-new-btn').click();
    await page.locator('.notes-textarea').fill('# Task\n\nthings to do');
    await page.waitForTimeout(900);

    // Mark done and go back.
    await page.locator('.notes-done-toggle input').check();
    await page.waitForTimeout(900);
    await page.locator('.notes-back').click();

    // Active tab is empty.
    await expect(page.locator('.notes-empty')).toContainText('No notes yet');

    // Done tab has the note.
    await page.locator('.notes-filter-tab', { hasText: 'Done' }).click();
    await expect(page.locator('.notes-list-title')).toContainText('Task');

    // Filter tab counts.
    const activeTab = page.locator('.notes-filter-tab', { hasText: 'Active' });
    await expect(activeTab.locator('.notes-filter-count')).toHaveText('0');
    const doneTab = page.locator('.notes-filter-tab', { hasText: 'Done' });
    await expect(doneTab.locator('.notes-filter-count')).toHaveText('1');
  });

  test('Delete removes the note from disk', async () => {
    await openNotesPanel(page);
    await page.locator('.notes-new-btn').click();
    await page.locator('.notes-textarea').fill('# To delete\n\nbody');
    await page.waitForTimeout(900);

    // Confirm a file exists in the notes dir.
    const notesDir = path.join(userDataDir, 'projects', PROJECT_ID, 'notes');
    expect(fs.existsSync(notesDir)).toBe(true);
    const beforeFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    expect(beforeFiles.length).toBe(1);

    // Delete via editor's Delete button.
    await page.locator('.notes-delete-btn').click();

    // Back in list, no notes.
    await expect(page.locator('.notes-empty')).toContainText('No notes yet', { timeout: 3_000 });

    // File is gone.
    const afterFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    expect(afterFiles.length).toBe(0);
  });

  test('multiple notes: list sorts by updated desc', async () => {
    await openNotesPanel(page);
    // Create A
    await page.locator('.notes-new-btn').click();
    await page.locator('.notes-textarea').fill('# Alpha');
    await page.waitForTimeout(900);
    await page.locator('.notes-back').click();

    // Create B (most recently updated)
    await page.locator('.notes-new-btn').click();
    await page.locator('.notes-textarea').fill('# Beta');
    await page.waitForTimeout(900);
    await page.locator('.notes-back').click();

    // List shows Beta first.
    const titles = page.locator('.notes-list-title');
    await expect(titles.first()).toHaveText('Beta', { timeout: 3_000 });
    await expect(titles.nth(1)).toHaveText('Alpha');
  });
});
