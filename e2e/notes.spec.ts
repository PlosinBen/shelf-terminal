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

    // Wait for the note to fully load before typing — NotesView's load
    // effect resets `titleOverridden` and `title` from the fetched note,
    // and on a cold app (per-test fixture) that effect can race with our
    // first .fill() and clobber it. The post-load focus() (line 286 of
    // NotesView) is the canonical "ready" signal.
    await expect(page.locator('.notes-textarea')).toBeFocused({ timeout: 5_000 });

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

    // Mark done. NotesView's handleToggleDone calls onRequestBack on the
    // "checked" transition — UI auto-pops back to the list and saves with
    // isDone=true. Don't click `.notes-back` manually after this — the
    // button no longer exists by the time we'd click it (Playwright would
    // wait for it up to test timeout, ending with a confusing
    // "Target page, context or browser has been closed" error).
    await page.locator('.notes-done-toggle input').check();

    // Active tab is empty.
    await expect(page.locator('.notes-empty')).toContainText('No notes yet', { timeout: 3_000 });

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

  // ── Quick Note overlay ──

  test('mod+shift+n opens quick note overlay', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const overlay = page.locator('.quick-note-overlay');
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.quick-note-textarea')).toBeFocused();
  });

  test('Esc cancels quick note without creating a file', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const textarea = page.locator('.quick-note-textarea');
    await expect(textarea).toBeFocused({ timeout: 3_000 });
    await textarea.fill('this should not persist');
    await page.keyboard.press('Escape');
    await expect(page.locator('.quick-note-overlay')).not.toBeVisible({ timeout: 3_000 });

    // Verify no note file landed on disk.
    const notesDir = path.join(userDataDir, 'projects', PROJECT_ID, 'notes');
    const files = fs.existsSync(notesDir)
      ? fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'))
      : [];
    expect(files.length).toBe(0);
  });

  test('Enter submits quick note and it appears in Notes list', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const textarea = page.locator('.quick-note-textarea');
    await expect(textarea).toBeFocused({ timeout: 3_000 });
    await textarea.fill('# Quick capture\n\nfollow-up body');
    await page.keyboard.press('Enter');
    await expect(page.locator('.quick-note-overlay')).not.toBeVisible({ timeout: 3_000 });

    // Note file exists on disk.
    const notesDir = path.join(userDataDir, 'projects', PROJECT_ID, 'notes');
    const files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);

    // Title auto-derived from `# heading` and shows in the list.
    await openNotesPanel(page);
    await expect(page.locator('.notes-list-title')).toContainText('Quick capture');
  });

  test('Shift+Enter inserts newline, does not submit', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const textarea = page.locator('.quick-note-textarea');
    await expect(textarea).toBeFocused({ timeout: 3_000 });
    await textarea.type('line one');
    await page.keyboard.press('Shift+Enter');
    await textarea.type('line two');

    // Still open after Shift+Enter.
    await expect(page.locator('.quick-note-overlay')).toBeVisible();
    await expect(textarea).toHaveValue('line one\nline two');
  });

  test('paste image into quick note: thumbnail appears + saves to disk + frontmatter has filename', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const textarea = page.locator('.quick-note-textarea');
    await expect(textarea).toBeFocused({ timeout: 3_000 });

    // Dispatch a synthetic paste with a minimal 1x1 PNG. `ClipboardEvent`'s
    // clipboardData is normally readonly but Chromium accepts it via
    // ClipboardEventInit when running under Playwright.
    await page.evaluate(async () => {
      const png = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);
      const file = new File([png], 'shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('.quick-note-textarea') as HTMLTextAreaElement;
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // Thumbnail row should render (one image-wrap element under quick-note-images).
    await expect(page.locator('.quick-note-images .notes-image-wrap')).toHaveCount(1, { timeout: 5_000 });

    // Image bytes landed in projects/<id>/images/.
    const imagesDir = path.join(userDataDir, 'projects', PROJECT_ID, 'images');
    expect(fs.existsSync(imagesDir)).toBe(true);
    const imgFiles = fs.readdirSync(imagesDir).filter((f) => f.endsWith('.png'));
    expect(imgFiles.length).toBe(1);
    const imageFilename = imgFiles[0];

    // Add some body text and submit.
    await textarea.fill('caption for the screenshot');
    await page.keyboard.press('Enter');
    await expect(page.locator('.quick-note-overlay')).not.toBeVisible({ timeout: 3_000 });

    // Note file exists and frontmatter `images:` references the saved file.
    const notesDir = path.join(userDataDir, 'projects', PROJECT_ID, 'notes');
    const noteFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    expect(noteFiles.length).toBe(1);
    const noteContent = fs.readFileSync(path.join(notesDir, noteFiles[0]), 'utf-8');
    expect(noteContent).toContain(`images: ["${imageFilename}"]`);
    expect(noteContent).toContain('caption for the screenshot');
  });

  test('pure-image submission (no text) creates the note', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const textarea = page.locator('.quick-note-textarea');
    await expect(textarea).toBeFocused({ timeout: 3_000 });

    await page.evaluate(async () => {
      const png = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);
      const file = new File([png], 'shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('.quick-note-textarea') as HTMLTextAreaElement;
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    await expect(page.locator('.quick-note-images .notes-image-wrap')).toHaveCount(1, { timeout: 5_000 });

    // Submit with empty body — should still create the note because there's
    // at least one image attached.
    await page.keyboard.press('Enter');
    await expect(page.locator('.quick-note-overlay')).not.toBeVisible({ timeout: 3_000 });

    const notesDir = path.join(userDataDir, 'projects', PROJECT_ID, 'notes');
    const noteFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    expect(noteFiles.length).toBe(1);
  });

  test('remove pasted image before submit', async () => {
    await page.keyboard.press(`${modifier}+Shift+n`);
    const textarea = page.locator('.quick-note-textarea');
    await expect(textarea).toBeFocused({ timeout: 3_000 });

    await page.evaluate(async () => {
      const png = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);
      const file = new File([png], 'shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('.quick-note-textarea') as HTMLTextAreaElement;
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    const thumb = page.locator('.quick-note-images .notes-image-wrap');
    await expect(thumb).toHaveCount(1, { timeout: 5_000 });

    // Click ✕ on the thumbnail to remove it.
    await thumb.locator('.notes-image-remove').click();
    await expect(thumb).toHaveCount(0);
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
