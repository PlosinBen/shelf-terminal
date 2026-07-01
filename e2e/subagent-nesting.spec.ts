import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Subagent single-home display — end-to-end over the fake provider
 * (SHELF_TEST_MODE=1). A dispatched subagent (Task/Agent tool) must surface in
 * exactly ONE place: its outer Agent card in the message list, with the
 * subagent's inner steps NESTED inside that card — never flat in the main list,
 * and never a card in the background-tasks panel.
 *
 * Scenario (agent-server/providers/fake/index.ts):
 *   subagent:<label> → outer Task card + inner steps tagged parentToolUseId +
 *                      the outer completion. Emits NO task_event (mirrors a real
 *                      subagent post-filter in routeTask). See subagent-display.
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

test.describe('subagent nesting via fake provider', () => {
  test('nests inner steps under the Agent card and never cards in the background panel', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'subagent:deploy dashboard');

    const response = page.locator('.agent-turn-response').first();

    // The outer Agent/Task card renders in the main list.
    const outer = response
      .locator('.agent-msg-fold', { has: page.locator('.fold-label', { hasText: 'Task' }) })
      .first();
    await expect(outer).toBeVisible({ timeout: 5_000 });

    // Single home: a subagent NEVER shows in the background-tasks panel.
    await expect(page.locator('.agent-tasks-panel')).toHaveCount(0);

    // The outer Task card is the ONLY top-level fold in the response — the inner
    // steps are not flat siblings in the main list.
    await expect(response.locator(':scope > .agent-msg-fold')).toHaveCount(1);

    // Ensure the outer card is expanded (clicking the header toggles).
    const nested = outer.locator('.agent-subagent-nested');
    if (!(await nested.isVisible().catch(() => false))) {
      await outer.locator('.fold-header').first().click();
    }
    await expect(nested).toBeVisible();

    // The subagent's inner tool_use + prose live INSIDE the nested container.
    await expect(nested.locator('.fold-label', { hasText: 'Read' })).toBeVisible();
    await expect(nested).toContainText('subagent step: deploy dashboard');
  });

  test('collapsing the Agent card hides the nested subagent steps', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'subagent:research');

    const response = page.locator('.agent-turn-response').first();
    const outer = response
      .locator('.agent-msg-fold', { has: page.locator('.fold-label', { hasText: 'Task' }) })
      .first();
    await expect(outer).toBeVisible({ timeout: 5_000 });

    const nested = outer.locator('.agent-subagent-nested');
    // Expand if needed, confirm nested shows, then collapse → nested gone.
    if (!(await nested.isVisible().catch(() => false))) {
      await outer.locator('.fold-header').first().click();
    }
    await expect(nested).toBeVisible();
    await outer.locator('.fold-header').first().click();
    await expect(nested).toHaveCount(0);
  });
});
