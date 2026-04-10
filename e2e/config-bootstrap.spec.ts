import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// These tests launch their own Electron instance per test (rather than reusing
// the worker-scoped fixture in helpers.ts) because each case needs precise
// control over projects.json contents and bootstrap-time env vars.

function getUserDataDir(): string {
  const suffix = process.env.NODE_ENV ? `-${process.env.NODE_ENV}` : '';
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', `shelf-terminal${suffix}`)
    : path.join(os.homedir(), '.config', `shelf-terminal${suffix}`);
}

async function launchApp(env: Record<string, string | undefined> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, ...env } as Record<string, string>,
  });
}

function cleanupCorruptBackups(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('projects.json.corrupt.') || f.startsWith('settings.json.corrupt.')) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

test.describe('config bootstrap', () => {
  let userDataDir: string;
  let projectsPath: string;

  test.beforeEach(() => {
    userDataDir = getUserDataDir();
    projectsPath = path.join(userDataDir, 'projects.json');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    cleanupCorruptBackups(userDataDir);
  });

  test.afterEach(() => {
    cleanupCorruptBackups(userDataDir);
    // Restore baseline so unrelated tests in the worker keep a clean slate.
    fs.writeFileSync(projectsPath, '[]', 'utf-8');
  });

  test('empty projects.json starts with empty sidebar', async () => {
    fs.writeFileSync(projectsPath, '[]', 'utf-8');
    const app = await launchApp();
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
    const app = await launchApp();
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
    const app = await launchApp({ SHELF_BOOTSTRAP_DIALOG_RESPONSE: 'quit' });
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
    const app = await launchApp({ SHELF_BOOTSTRAP_DIALOG_RESPONSE: 'continue' });
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
