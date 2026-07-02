import { test, expect, openAgentTab } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Init-readiness gate: the input is usable ONLY after the backend reports init
 * 'ready' (capabilities gathered). When the caps RPC fails — here forced via the
 * fake provider's SHELF_TEST_CAPS_FAIL hook, mirroring a real Copilot caps-RPC
 * timeout / SDK-link failure — init lands 'failed', and the textarea must be
 * locked (disabled, no send, no queued chip) with the Retry pane shown instead.
 *
 * A caps failure is deliberately NOT recoverable by "just send anyway": a
 * timeout means the shared agent-server ↔ CLI link is unhealthy, so pretending
 * the agent is available (letting a message queue) would strand the send. See
 * remote.ts getCapabilities (reject, don't resolve empty) + InputZone gate.
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

test.describe('agent init-readiness gate', () => {
  test.describe('caps RPC fails → init locked', () => {
    test.use({ capsFail: true });

    test('failed init locks the input (disabled, no send) and shows Retry', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // Failed pane + Retry affordance (MessageList init-failed branch).
      await expect(page.locator('.agent-init-failed')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.agent-init-failed')).toContainText('Failed to start agent');
      await expect(page.locator('.agent-init-failed button', { hasText: 'Retry' })).toBeVisible();

      // The gate: textarea disabled + honest placeholder, so no send can be typed.
      const ta = page.locator('.agent-textarea:visible');
      await expect(ta).toBeDisabled();
      await expect(ta).toHaveAttribute('placeholder', 'Agent unavailable — retry above');

      // And nothing was optimistically queued: no pending chip in the timeline.
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0);
    });
  });

  test('ready init unlocks the input (enabled, sendable)', async ({ shelfApp: { page } }) => {
    // No capsFail → normal fake → init 'ready'. Contrast case for the gate.
    await setupProject(page);
    await openAgentTab(page);

    const ta = page.locator('.agent-textarea:visible');
    await expect(ta).toBeEnabled();
    await expect(ta).toHaveAttribute('placeholder', 'Ask something...');
    await expect(page.locator('.agent-init-failed')).toHaveCount(0);
  });
});
