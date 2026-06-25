import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Web tab E2E — structural verification of the third tab type (no network):
 *   add menu → "Web" → web tab renders with toolbar, address bar, the
 *   `persist:web` <webview>, and the local-identity chip.
 *
 * Navigation against real services is intentionally NOT exercised here (would
 * need network + a logged-in session); that's dogfooded at Phase 4.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Mirrors agent-picker.spec.ts setupProject.
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
  await page.locator('.tab-add').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Web' }).click();
}

test.describe('web tab', () => {
  test('opens a web tab with toolbar, address bar, scoped webview, and identity chip', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openWebTab(page);

    await expect(page.locator('.web-tab-toolbar:visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.web-tab-address:visible')).toBeVisible();
    await expect(page.locator('.web-tab-identity:visible')).toContainText('Local');

    // The webview must use the shared persist:web partition (same store the
    // agent's web.fetch rides). 'persist:web' is the canonical partition name.
    await expect(page.locator('webview[partition="persist:web"]')).toHaveCount(1);

    // A second tab was added alongside the initial terminal.
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  });

  test('address bar accepts input', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openWebTab(page);

    const address = page.locator('.web-tab-address:visible');
    await address.fill('kibana.corp.com');
    await expect(address).toHaveValue('kibana.corp.com');
  });

  test('settings → Web tab manages sessions and grants (empty states via IPC)', async ({ shelfApp: { page } }) => {
    await page.keyboard.press(`${modifier}+,`);
    await expect(page.locator('.settings-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('.settings-tab', { hasText: 'Web' }).click();

    const body = page.locator('.web-settings');
    await expect(body).toBeVisible();
    await expect(body).toContainText('Logged-in sessions');
    await expect(body).toContainText('Agent web access');
    // listSessions / listGrants IPC round-trip resolves to empty on a fresh app.
    await expect(body).toContainText('No logged-in sessions.');
    await expect(body).toContainText('No grants yet.');
  });

  test('web.fetch raises the app-global permission popup with the parsed origin; allow once', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'webfetch:https://kibana.corp.com/api/status');

    // The gate is provider-agnostic (main handleAppTool) and surfaces a
    // dedicated app-global popup, NOT the agent timeline's permission panel.
    const popup = page.locator('.web-perm-overlay');
    await expect(popup).toBeVisible({ timeout: 5_000 });
    // Anti-spoof: the authoritatively-parsed origin is shown.
    await expect(popup.locator('.web-perm-origin')).toContainText('https://kibana.corp.com');
    await expect(popup.locator('.agent-perm-option', { hasText: 'Always allow this origin' })).toBeVisible();

    await popup.locator('.agent-perm-option', { hasText: 'Allow once' }).click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });
  });

  test('allow always persists a per-project grant shown in Settings → Web', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await sendAgentPrompt(page, 'webfetch:https://argocd.corp.com/api/v1/applications');

    const popup = page.locator('.web-perm-overlay');
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.agent-perm-option', { hasText: 'Always allow this origin' }).click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    // Grant persisted (key = origin) and surfaced in the whitelist UI.
    await page.keyboard.press(`${modifier}+,`);
    await expect(page.locator('.settings-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('.settings-tab', { hasText: 'Web' }).click();
    await expect(page.locator('.web-settings')).toContainText('https://argocd.corp.com', { timeout: 5_000 });
  });
});
