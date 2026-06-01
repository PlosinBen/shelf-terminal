import { test, expect } from './helpers';
import path from 'path';
import fs from 'fs';

// dir-size specs verify the `formatBytes(...) · N file/files` badges next to
// Clear Logs (Settings) and Clear uploaded files (Project Edit). We need
// filesystem-level seeding to populate the dirs, so we reach into the
// fixture's userDataDir to write files between launch and the panel opening.
// The size IPC handler walks the dir live each call — seeding after launch
// is fine.
//
// Critically, this file uses the shared `test` from helpers.ts rather than
// importing `_electron` from `@playwright/test` directly. Two specs both
// holding direct references to `_electron` triggered cross-file interference
// in this project's setup (notes.spec.ts:122 timed out as soon as dir-size
// loaded). Routing through the single fixture in helpers.ts keeps the
// launcher reference centralized.

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

function writeBytes(filePath: string, bytes: number) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes), { flag: 'w' });
}

async function openSettings(page: any) {
  await page.keyboard.press(`${modifier}+,`);
  await expect(page.locator('.settings-panel')).toBeVisible({ timeout: 5_000 });
}

// ──────────────────────────────────────────────────────────────────────────
// Logs size — Settings panel
// ──────────────────────────────────────────────────────────────────────────

test('Logs size: empty userData/logs shows "0 B · 0 files"', async ({ shelfApp: { page } }) => {
  await openSettings(page);
  const sizeText = page.locator('.settings-logs-size');
  await expect(sizeText).toContainText('0 B · 0 files', { timeout: 5_000 });
});

test('Logs size: seeded log file shows formatted size + count', async ({ shelfApp: { page, userDataDir } }) => {
  // 2048 bytes = exactly 2.0 KB so the assertion is robust against toFixed
  // rounding edge cases.
  writeBytes(path.join(userDataDir, 'logs', '202606', '0530.log'), 2048);

  await openSettings(page);
  const sizeText = page.locator('.settings-logs-size');
  // Singular ("file" not "files") pins the pluralization branch in SettingsPanel.
  await expect(sizeText).toContainText('2.0 KB · 1 file', { timeout: 5_000 });
});

test('Logs size: Clear Logs refetches display to "0 B · 0 files"', async ({ shelfApp: { page, userDataDir } }) => {
  writeBytes(path.join(userDataDir, 'logs', '202606', '0530.log'), 1024);

  await openSettings(page);
  const sizeText = page.locator('.settings-logs-size');
  await expect(sizeText).toContainText('1.0 KB', { timeout: 5_000 });

  await page.locator('button', { hasText: 'Clear Logs' }).click();
  await expect(sizeText).toContainText('0 B · 0 files', { timeout: 5_000 });
});

// ──────────────────────────────────────────────────────────────────────────
// Uploaded files size — Project Edit panel
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create a local project via the folder picker UI (mirrors features.spec.ts
 * setupProject), then open Project Edit on it. Returns the project's cwd
 * (read from `<userDataDir>/projects.json` — the on-disk truth, not a DOM
 * attribute which isn't reliably present) so the test can seed files under
 * `<cwd>/.tmp/shelf/`.
 */
async function setupProjectAndOpenEdit(page: any, userDataDir: string): Promise<string> {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  // Wait for projects.json to be written with the new project (renderer
  // saves via project:save IPC). Poll briefly because save is async.
  let cwd = '';
  for (let i = 0; i < 50; i++) {
    try {
      const raw = fs.readFileSync(path.join(userDataDir, 'projects.json'), 'utf-8');
      const projects = JSON.parse(raw) as Array<{ cwd: string }>;
      if (projects.length > 0 && projects[0].cwd) {
        cwd = projects[0].cwd;
        break;
      }
    } catch { /* file may not exist yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible({ timeout: 3_000 });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  await expect(page.locator('.project-edit-panel')).toBeVisible({ timeout: 3_000 });

  return cwd;
}

async function reopenProjectEdit(page: any) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible({ timeout: 3_000 });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  await expect(page.locator('.project-edit-panel')).toBeVisible({ timeout: 3_000 });
}

test('Uploads size: empty .tmp/shelf shows "0 B · 0 files"', async ({ shelfApp: { page, userDataDir } }) => {
  await setupProjectAndOpenEdit(page, userDataDir);
  const sizeText = page.locator('.project-edit-uploads-size');
  await expect(sizeText).toContainText('0 B · 0 files', { timeout: 5_000 });
});

test('Uploads size: seeded upload file shows formatted size + count', async ({ shelfApp: { page, userDataDir } }) => {
  const cwd = await setupProjectAndOpenEdit(page, userDataDir);
  // Bail if cwd not found — would be a setup regression, not a feature failure.
  expect(cwd.length).toBeGreaterThan(0);

  // Close, seed file, reopen so the on-open fetch picks it up.
  await page.locator('.settings-close').click();
  await expect(page.locator('.project-edit-panel')).not.toBeVisible({ timeout: 3_000 });
  writeBytes(path.join(cwd, '.tmp', 'shelf', 'abc-test.txt'), 512);

  try {
    await reopenProjectEdit(page);
    const sizeText = page.locator('.project-edit-uploads-size');
    await expect(sizeText).toContainText('512 B · 1 file', { timeout: 5_000 });
  } finally {
    // Cleanup so we don't leave bytes lying around in the user's home dir
    // even if the assertion failed.
    fs.rmSync(path.join(cwd, '.tmp'), { recursive: true, force: true });
  }
});

test('Uploads size: Clear uploaded files refetches to "0 B · 0 files"', async ({ shelfApp: { app, page, userDataDir } }) => {
  const cwd = await setupProjectAndOpenEdit(page, userDataDir);
  expect(cwd.length).toBeGreaterThan(0);

  await page.locator('.settings-close').click();
  await expect(page.locator('.project-edit-panel')).not.toBeVisible({ timeout: 3_000 });
  writeBytes(path.join(cwd, '.tmp', 'shelf', 'abc-one.txt'), 256);
  writeBytes(path.join(cwd, '.tmp', 'shelf', 'def-two.txt'), 256);

  try {
    await reopenProjectEdit(page);
    const sizeText = page.locator('.project-edit-uploads-size');
    await expect(sizeText).toContainText('512 B · 2 files', { timeout: 5_000 });

    // Electron's native confirm dialog can't be driven through the page —
    // patch dialog.showMessageBox in main so confirm auto-returns "OK"
    // (response: 0) and the follow-up success warn becomes a no-op.
    await app.evaluate(({ dialog }) => {
      (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });

    await page.locator('button', { hasText: 'Clear uploaded files' }).click();
    await expect(sizeText).toContainText('0 B · 0 files', { timeout: 5_000 });
  } finally {
    fs.rmSync(path.join(cwd, '.tmp'), { recursive: true, force: true });
  }
});
