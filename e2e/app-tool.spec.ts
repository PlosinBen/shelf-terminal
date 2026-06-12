import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * App-tool bridge — end-to-end over the fake provider (SHELF_TEST_MODE=1).
 * Exercises the full server→main round-trip: the fake's `apptool:<op>` scenario
 * calls callMain(op) in agent-server → the `app_tool` request is intercepted by
 * main's transport-level handler (remote.ts) → handleAppTool routes to
 * skills-store → main replies `app_tool_result` → the bridge tool resolves and
 * the fake renders the result. See .agent/features/app-level-capabilities.md.
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

test.describe('app-tool bridge via fake provider', () => {
  test('app_skill.list round-trips agent-server → main → skills-store → reply', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'apptool:app_skill.list');

    // The reply carries the bridge result. The handler reached skills-store and
    // returned ok:true (empty list under the isolated test userData) — proving
    // the whole server→main→skills-store→back chain, not a stub.
    const reply = page.locator('.agent-turn-response');
    await expect(reply).toContainText('apptool app_skill.list', { timeout: 8_000 });
    await expect(reply).toContainText('"ok":true');
    await expect(reply).toContainText('"skills":');
  });

  test('unknown op comes back as ok:false (handler never throws)', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);

    await sendAgentPrompt(page, 'apptool:app_skill.frobnicate');

    const reply = page.locator('.agent-turn-response');
    await expect(reply).toContainText('"ok":false', { timeout: 8_000 });
    await expect(reply).toContainText('unknown app_tool op');
  });
});
