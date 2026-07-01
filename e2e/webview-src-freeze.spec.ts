import { test, expect } from './helpers';
import type { Page } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Regression for web-tab#9 — the webview `src` must be frozen at mount.
 *
 * Bug: `<webview src>` was bound to the live `tab.url`, which the webview's own
 * `did-navigate` writes back into the store (setWebTabUrl). Every navigation
 * therefore rewrote the `src` attribute → the webview re-issued a fresh
 * top-level GET, aborting in-flight redirects (ERR_ABORTED loop) and dropping
 * SAML POST-binding params (Azure AADSTS750054 on ArgoCD SSO).
 *
 * We reproduce the mechanism with a local 302 redirect: `/start` → `/final`.
 * After the redirect settles, the settled page (`/final`) must have been loaded
 * exactly ONCE. Pre-fix, the src-rewrite feedback re-navigated to it → a second
 * hit. The redundant reload is the true behavioral signal: the `src` DOM
 * attribute itself is NOT a usable invariant here — Electron mirrors the
 * committed navigation URL back into `<webview src>`, so it reads `.../final`
 * regardless of the fix. Only the reload count distinguishes fixed vs broken.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

async function openWebTab(page: Page) {
  await page.locator('.tab-add').click();
  await page.locator('.context-menu-item', { hasText: 'Web' }).click();
}

test.describe('webview src freeze (web-tab#9)', () => {
  let server: http.Server;
  let finalHits = 0;
  let baseUrl = '';

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      if (req.url === '/final') {
        finalHits++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>final ok</body></html>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a redirect settles once and does not re-load via a src rewrite', async ({ shelfApp: { page } }) => {
    finalHits = 0;
    await setupProject(page);
    await openWebTab(page);

    const webview = page.locator('webview[partition="persist:web"]');
    // Fresh tab starts at the blank starter page (before any navigation, the
    // src attribute still reflects the mount value).
    await expect(webview).toHaveAttribute('src', 'about:blank');

    const address = page.locator('.web-tab-address:visible');
    await address.click();
    await address.fill(`${baseUrl}/start`);
    await address.press('Enter');

    // The 302 resolves and the address bar reflects the settled URL — proves
    // did-navigate fired (and thus setWebTabUrl wrote tab.url, the loop's trigger).
    await expect(address).toHaveValue(/\/final$/, { timeout: 10_000 });

    // Give any (buggy) src-rewrite reload time to hit the server, then assert the
    // settled page was fetched exactly once — no redundant re-navigation.
    await page.waitForTimeout(1_000);
    expect(finalHits).toBe(1);
  });
});
