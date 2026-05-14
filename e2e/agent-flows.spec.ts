import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Agent rendering flows beyond picker — exercises every other major wire
 * event the renderer must handle: permission_request, streaming chunks
 * pairing with finalize, tool_use cards (success + error), error events,
 * auth_required pane, and stop mid-turn.
 *
 * All driven via the fake provider (SHELF_TEST_MODE=1, see helpers.ts).
 * Scenarios documented in `agent-server/providers/fake.ts`.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

test.describe('agent flows via fake provider', () => {
  test.describe('permission', () => {
    test('Allow once → tool runs, success system message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'permission:Bash');

      const panel = page.locator('.agent-permission:visible');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await expect(panel).toContainText('Bash');

      await panel.locator('.agent-perm-option', { hasText: 'Allow once' }).click();
      await expect(page.locator('.agent-messages:visible')).toContainText('permission allowed: Bash', { timeout: 5_000 });
    });

    test('Deny → deny system message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'permission:Write');

      const panel = page.locator('.agent-permission:visible');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await panel.locator('.agent-perm-option', { hasText: 'Deny' }).click();

      await expect(page.locator('.agent-messages:visible')).toContainText('permission denied: Write', { timeout: 5_000 });
    });
  });

  test.describe('streaming', () => {
    test('text stream chunks finalize into a single message', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      // Two stream chunks → one finalize. After settling we expect the
      // finalized message present with the full content (upsert behavior:
      // chunks share msgId with finalize, no duplication).
      await sendAgentPrompt(page, 'text:hello world');

      const messages = page.locator('.agent-messages:visible');
      await expect(messages).toContainText('hello world', { timeout: 5_000 });

      // Status should drop to idle after the turn completes.
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
    });
  });

  test.describe('tool_use', () => {
    test('tool: renders a tool card with the tool name and ok result', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool:Read');

      const toolCard = page.locator('.agent-msg-tool:visible').last();
      await expect(toolCard).toBeVisible({ timeout: 5_000 });
      await expect(toolCard.locator('.agent-tool-name')).toHaveText('Read');
    });

    test('tool_err: marks result block as error', async ({ shelfApp: { page } }) => {
      await setupProject(page);
      await openAgentTab(page);
      await sendAgentPrompt(page, 'tool_err:Bash');

      const toolCard = page.locator('.agent-msg-tool:visible').last();
      await expect(toolCard).toBeVisible({ timeout: 5_000 });
      await expect(toolCard.locator('.agent-tool-name')).toHaveText('Bash');
      // Expand to surface the result block (collapsed by default).
      await toolCard.locator('.agent-tool-header').click();
      await expect(toolCard.locator('.agent-tool-result-error')).toBeVisible();
    });
  });

  test('auth_required swaps the view for the auth pane', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'auth_required');

    // The entire agent view flips to the auth pane on auth_required.
    await expect(page.locator('.agent-auth-pane:visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.agent-auth-title:visible')).toContainText('Fake');
  });

  test('error event renders as an error message', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'error:something broke');

    const err = page.locator('.agent-msg-error:visible').last();
    await expect(err).toBeVisible({ timeout: 5_000 });
    await expect(err).toContainText('something broke');
  });

  test('stop via double-Esc cancels mid-turn picker', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // delay:5000 keeps the turn open in case picker resolves fast on its own;
    // we hit Esc to abort once the panel is visible.
    await sendAgentPrompt(page, 'picker_single|delay:5000');

    const panel = page.locator('.picker-panel:visible');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // First Esc dismisses the picker (cancelled payload echoed back).
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    // Then the turn is still running due to `delay:5000` — second Esc twice
    // hits the stop affordance ("Press Esc again to stop").
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Status returns to idle after stop().
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });
  });
});
