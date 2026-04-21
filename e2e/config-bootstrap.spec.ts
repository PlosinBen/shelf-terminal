import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// These tests launch their own Electron instance per test (rather than reusing
// the worker-scoped fixture in helpers.ts) because each case needs precise
// control over projects.json contents and bootstrap-time env vars.
//
// Each test uses a fresh tmpdir as userData via --user-data-dir so it's
// isolated from the developer's real dev/prod data (commit d27fc26 dropped
// NODE_ENV-based isolation in favor of this command-line switch).

async function launchApp(
  userDataDir: string,
  env: Record<string, string | undefined> = {},
): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ...env } as Record<string, string>,
  });
}

test.describe('config bootstrap', () => {
  let userDataDir: string;
  let projectsPath: string;

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-bootstrap-'));
    projectsPath = path.join(userDataDir, 'projects.json');
  });

  test.afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('empty projects.json starts with empty sidebar', async () => {
    fs.writeFileSync(projectsPath, '[]', 'utf-8');
    const app = await launchApp(userDataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
      await expect(page.locator('.sidebar-item')).toHaveCount(0);
    } finally {
      await app.close().catch(() => {});
    }
  });

  test('missing projects.json (ENOENT) starts with empty sidebar', async () => {
    if (fs.existsSync(projectsPath)) fs.unlinkSync(projectsPath);
    const app = await launchApp(userDataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
      await expect(page.locator('.sidebar-item')).toHaveCount(0);
    } finally {
      await app.close().catch(() => {});
    }
  });

  test('corrupt projects.json with quit response exits app', async () => {
    fs.writeFileSync(projectsPath, '{garbage', 'utf-8');
    const app = await launchApp(userDataDir, { SHELF_BOOTSTRAP_DIALOG_RESPONSE: 'quit' });
    // App should exit without ever opening a window.
    await app.waitForEvent('close', { timeout: 10_000 });
    // The corrupt file should still be in place (no backup happened).
    expect(fs.existsSync(projectsPath)).toBe(true);
    expect(fs.readFileSync(projectsPath, 'utf-8')).toBe('{garbage');
    const backups = fs
      .readdirSync(userDataDir)
      .filter((f) => f.startsWith('projects.json.corrupt.'));
    expect(backups).toHaveLength(0);
  });

  test('corrupt projects.json with continue backs up and starts empty', async () => {
    fs.writeFileSync(projectsPath, '{garbage', 'utf-8');
    const app = await launchApp(userDataDir, { SHELF_BOOTSTRAP_DIALOG_RESPONSE: 'continue' });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
      await expect(page.locator('.sidebar-item')).toHaveCount(0);

      // Original projects.json should be moved aside.
      const backups = fs
        .readdirSync(userDataDir)
        .filter((f) => f.startsWith('projects.json.corrupt.'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(userDataDir, backups[0]), 'utf-8')).toBe('{garbage');
    } finally {
      await app.close().catch(() => {});
    }
  });
});
