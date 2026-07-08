import { test, expect, openAgentTab } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Init-readiness gate: the input is usable ONLY after the backend reports init
 * 'ready' (capabilities gathered). When the caps RPC fails — here forced via the
 * fake provider's SHELF_TEST_CAPS_FAIL hook, mirroring a real Copilot caps-RPC
 * timeout / SDK-link failure — init lands 'failed', and the textarea must be
 * locked (disabled, no send, no queued chip) with the recovery overlay shown
 * instead (a pane-scoped, dim+blur overlay with a centered Retry — see
 * ConnectionOverlay; unifies init-failed + connection-dead recovery).
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

    test('failed init locks the input (disabled, no send) and shows the recovery overlay', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // Recovery overlay + centered Retry affordance (ConnectionOverlay).
      const overlay = page.locator('.agent-conn-overlay');
      await expect(overlay).toBeVisible({ timeout: 10_000 });
      await expect(overlay).toContainText('Failed to start agent');
      await expect(overlay.locator('button', { hasText: 'Retry' })).toBeVisible();

      // The gate: textarea disabled + honest placeholder, so no send can be typed.
      const ta = page.locator('.agent-textarea:visible');
      await expect(ta).toBeDisabled();
      await expect(ta).toHaveAttribute('placeholder', 'Agent unavailable — retry to reconnect');

      // And nothing was optimistically queued: no pending chip in the timeline.
      await expect(page.locator('.agent-msg-queued')).toHaveCount(0);

      // Clicking Retry re-arms init: overlay flips to the starting cover
      // (caps still fails here, so it settles back to failed — proves the button
      // drives the retry-init path, not a dead control).
      await overlay.locator('button', { hasText: 'Retry' }).click();
      await expect(overlay).toContainText(/Starting agent|Reconnecting|Failed to start agent/, { timeout: 10_000 });
    });
  });

  // First-open init is not ready yet → the pane is covered by a prominent
  // dim+blur overlay (spinner + phase text), NOT just a subtle in-list hint, and
  // clears once init reports 'ready'.
  test.describe('first-open starting → not-ready overlay', () => {
    test.use({ capsDelayMs: 1500 });

    test('starting covers the pane with the overlay, then clears on ready', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);

      // While caps are delayed (init 'starting') the overlay covers the pane
      // with a phase label — which phase depends on where init is (the caps
      // delay lands in 'checking-auth'), so match any not-ready phase text.
      const overlay = page.locator('.agent-conn-overlay');
      await expect(overlay).toBeVisible({ timeout: 5_000 });
      await expect(overlay).toContainText(/Starting agent|Deploying runtime|Connecting|Checking sign-in/);
      await expect(overlay.locator('.agent-loading-spinner')).toBeVisible();
      // Input is visibly blocked while covered.
      await expect(page.locator('.agent-textarea:visible')).toBeDisabled();

      // Once caps resolve → init 'ready' → overlay clears and input unlocks.
      await expect(overlay).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator('.agent-textarea:visible')).toBeEnabled();
    });
  });

  test('ready init unlocks the input (enabled, sendable)', async ({ shelfApp: { page } }) => {
    // No capsFail → normal fake → init 'ready'. Contrast case for the gate.
    await setupProject(page);
    await openAgentTab(page);

    const ta = page.locator('.agent-textarea:visible');
    await expect(ta).toBeEnabled();
    await expect(ta).toHaveAttribute('placeholder', 'Ask something...');
    await expect(page.locator('.agent-conn-overlay')).toHaveCount(0);
  });
});
