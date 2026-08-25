import { expect, test } from './helpers';
import type { ElectronApplication } from '@playwright/test';

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

test('external URL popup defaults to copy and supports cancel/open decisions', async ({ shelfApp: { app, page } }) => {
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
});
