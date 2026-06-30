import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * WSL connector upload E2E — the WSL counterpart of ssh.spec / docker.spec upload
 * coverage. Runs ONLY on a Windows host (needs `wsl.exe`); it has its own
 * playwright project (`wsl`) so non-Windows CI never invokes it. Run standalone:
 *   npm run test:wsl
 *
 * Regression for the Phase 2 refactor that routed `uploadFile` through the single
 * `putFile` byte primitive + a separate non-clobber `.tmp/.gitignore` guard. WSL
 * uploads had NO prior e2e, so this is the coverage the refactor needs. Authored
 * by mirroring agent-deploy-wsl-helpers (the author cannot run wsl.exe on macOS).
 *
 * Distro via SHELF_WSL_TEST_DISTRO (default 'Ubuntu').
 */

const DISTRO = process.env.SHELF_WSL_TEST_DISTRO || 'Ubuntu';

// Array form (execFileSync), NOT a shell string — the Windows host shell is
// cmd.exe, which does not understand POSIX quoting; the argv array bypasses it
// (same reason wslOps does this in src/main/agent/remote.ts).
function wsl(cmd: string): string {
  return execFileSync('wsl.exe', ['-d', DISTRO, '--', 'sh', '-c', cmd], { encoding: 'utf8', stdio: 'pipe' });
}

const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wsl-upload-'));
    const app = await electron.launch({
      args: [path.join(__dirname, '../..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' },
    });
    let page: Page;
    try {
      page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
    } catch (err) {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
      throw err;
    }
    await use({ app, page });
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }, { scope: 'worker' }],
});

test.skip(process.platform !== 'win32', 'WSL upload spec requires a Windows host (wsl.exe)');
test.setTimeout(60_000);

const conn = { type: 'wsl' as const, distro: DISTRO };

test('wsl: uploadFile streams the file into the distro under .tmp/shelf', async ({ shelfApp: { page } }) => {
  // Clean any prior scratch dir so the assertion is fresh.
  try { wsl('rm -rf /tmp/.tmp'); } catch { /* ignore */ }

  const result = await page.evaluate(
    async (c) => window.shelfApi.connector.uploadFile(
      c,
      '/tmp',
      'paste.txt',
      new TextEncoder().encode('hello-wsl').buffer,
    ),
    conn,
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.remotePath).toMatch(/^\/tmp\/\.tmp\/shelf\/[a-z0-9]+-paste\.txt$/);
  // Bytes landed in the distro via putFile.
  expect(wsl('cat /tmp/.tmp/shelf/*-paste.txt').trim()).toBe('hello-wsl');
  // The non-clobber gitignore guard created the marker.
  expect(wsl('cat /tmp/.tmp/.gitignore').trim()).toBe('*');
});

test('wsl: clearUploads wipes the distro upload dir and is idempotent', async ({ shelfApp: { page } }) => {
  await page.evaluate(
    async (c) => {
      await window.shelfApi.connector.uploadFile(c, '/tmp', 'a.txt', new TextEncoder().encode('a').buffer);
      await window.shelfApi.connector.uploadFile(c, '/tmp', 'b.txt', new TextEncoder().encode('b').buffer);
    },
    conn,
  );

  const first = await page.evaluate((c) => window.shelfApi.connector.clearUploads(c, '/tmp'), conn);
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.removed).toBeGreaterThanOrEqual(2);

  const second = await page.evaluate((c) => window.shelfApi.connector.clearUploads(c, '/tmp'), conn);
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.removed).toBe(0);
});
