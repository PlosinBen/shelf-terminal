import { expect, readActiveTerminalText, test } from './helpers';
import type { ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { LINK_OPEN } from '../src/shared/link-open-intent';

test.use({ homeProjectDirectories: false });

type IntentInput = {
  url: string;
  reason: string;
  source: { kind: 'app-window' };
};

async function requestIntent(app: ElectronApplication, input: IntentInput) {
  await app.evaluate((_electron: unknown, value: IntentInput) => {
    const testGlobal = globalThis as typeof globalThis & {
      __shelfTestRequestExternalUrlIntent?: (request: IntentInput) => Promise<string>;
      __shelfTestExternalUrlResults?: string[];
    };
    if (!testGlobal.__shelfTestRequestExternalUrlIntent) throw new Error('External URL test hook unavailable');
    testGlobal.__shelfTestExternalUrlResults ??= [];
    void testGlobal.__shelfTestRequestExternalUrlIntent(value).then((decision) => {
      testGlobal.__shelfTestExternalUrlResults!.push(decision);
    });
  }, input);
}

test('external URL popup defaults to copy and supports cancel/open decisions', async ({ shelfApp: { app, page, userDataDir } }) => {
  await app.evaluate(({ shell, clipboard }) => {
    const testGlobal = globalThis as typeof globalThis & { __shelfTestOpenedUrls?: string[] };
    testGlobal.__shelfTestOpenedUrls = [];
    clipboard.clear();
    shell.openExternal = async (url: string) => {
      testGlobal.__shelfTestOpenedUrls!.push(url);
    };
  });

  const copyUrl = 'https://login.example.com/oauth/authorize?state=exact-private-state';
  await requestIntent(app, { url: copyUrl, reason: 'Sign in to Example', source: { kind: 'app-window' } });

  const popup = page.locator('.external-url-intent-overlay');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.external-url-intent-source')).toHaveText('Requested by: Shelf app window');
  await expect(popup.locator('.external-url-intent-destination')).toHaveText('https://login.example.com');
  await expect(popup.locator('.external-url-intent-url')).toHaveText(copyUrl);
  await expect(popup.locator('.agent-perm-option')).toHaveCount(3);
  await expect(popup.locator('.agent-perm-option').nth(0)).toHaveClass(/selected/);
  await expect(popup.locator('.agent-perm-option').nth(0)).toContainText('Copy URL');
  await expect(popup.locator('.agent-perm-option').nth(1)).toContainText('Open with default app');
  await expect(popup.locator('.agent-perm-option').nth(2)).toContainText('Cancel');

  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(copyUrl);

  await requestIntent(app, {
    url: 'mailto:support@example.com?subject=Private',
    reason: 'Contact support',
    source: { kind: 'app-window' },
  });
  await expect(popup).toBeVisible();
  await expect(popup.locator('.external-url-intent-destination')).toHaveText('support@example.com');
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();

  const openUrl = 'https://docs.example.com/start?token=exact-private-token';
  await requestIntent(app, { url: openUrl, reason: 'Open documentation', source: { kind: 'app-window' } });
  await expect(popup).toBeVisible();
  await popup.locator('.agent-perm-option', { hasText: 'Open with default app' }).click();
  await expect(popup).not.toBeVisible();

  await expect.poll(() => app.evaluate(() => (
    (globalThis as typeof globalThis & { __shelfTestExternalUrlResults?: string[] })
      .__shelfTestExternalUrlResults
  ))).toEqual(['copy', 'cancel', 'open']);
  expect(await app.evaluate(() => (
    (globalThis as typeof globalThis & { __shelfTestOpenedUrls?: string[] }).__shelfTestOpenedUrls
  ))).toEqual([openUrl]);

  const cwd = path.join(userDataDir, 'terminal-project');
  fs.mkdirSync(cwd);
  await page.evaluate(cwd => window.shelfApi.project.add({ name: 'URL Terminal', cwd, connection: { type: 'local' }, maxTabs: 5 }), cwd);
  await page.reload();
  await page.locator('.sidebar-item', { hasText: 'URL Terminal' }).click();
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await expect(page.locator('.terminal-loading')).toBeHidden({ timeout: 5_000 });

  const rendererLink = 'https://renderer.example.com/path?state=exact-renderer-state';
  await page.evaluate(({ url, attr }) => {
    const anchor = document.createElement('a');
    anchor.id = 'external-url-e2e-link';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.setAttribute(attr, 'external');
    anchor.textContent = 'External URL E2E link';
    document.body.appendChild(anchor);
  }, { url: rendererLink, attr: LINK_OPEN.destinationAttribute });
  await page.locator('#external-url-e2e-link').click();

  await expect(popup).toBeVisible();
  await expect(popup.locator('.external-url-intent-source')).toContainText('Requested by: Shelf app window');
  await expect(popup.locator('.external-url-intent-url')).toHaveText(rendererLink);
  await popup.locator('.agent-perm-option', { hasText: 'Cancel' }).click();
  await expect(popup).not.toBeVisible();

  const terminalUrl = 'https://terminal.example.com/oauth?state=exact-terminal-state';
  await page.locator('.terminal-container:visible .xterm-screen').click({ force: true });
  await page.keyboard.type(`"$BROWSER" '${terminalUrl}'\n`);

  await expect(popup).toBeVisible();
  await expect(popup.locator('.external-url-intent-source')).toContainText('Requested by: URL Terminal /');
  await expect(popup.locator('.external-url-intent-url')).toHaveText(terminalUrl);
  await page.keyboard.press('Enter');
  await expect(popup).not.toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(terminalUrl);
  await expect.poll(async () => readActiveTerminalText(page)).not.toContain('6973;external-url;1;');
});
