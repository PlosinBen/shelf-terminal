import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

/**
 * browser_open E2E — the agent tool that opens a visible Web tab for the user to
 * log in. Exercises the real per-call Open/Deny popup (main browser-open gate,
 * provider-agnostic) and the post-approval open-Web-tab path, via the fake
 * provider's `browser_open:<url>` scenario. No network — we test the gate + tab
 * open, not a real login.
 *
 * The popup deliberately offers ONLY Open/Deny (no "remember"), so a single
 * approval can never enable a later background open.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

// Mirrors web-tab.spec.ts setupProject.
async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

async function setupNamedProject(page: Page, name: string) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.locator('.folder-picker-item', { hasText: name }).click();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
}

test.describe('browser_open', () => {
  test('focuses and names the requesting project before showing a background request', async ({ shelfApp: { page } }) => {
    await setupNamedProject(page, 'shelf-test-a');
    await setupNamedProject(page, 'shelf-test-b');
    const projects = page.locator('.sidebar-item');
    await expect(projects).toHaveCount(2);

    await openAgentTab(page);
    await sendAgentPrompt(page, 'delay:800|browser_open:https://kibana.corp.com/login');
    await projects.nth(0).click();
    await expect(projects.nth(0)).toHaveClass(/active/);

    const popup = page.locator('.web-perm-overlay');
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(projects.nth(1)).toHaveClass(/active/);
    await expect(popup.locator('.project-requester')).toHaveText('Requested by: shelf-test-b');

    await popup.locator('.agent-perm-option', { hasText: 'Deny' }).click();
    await expect(projects.nth(1)).toHaveClass(/active/);
  });

  test('pops an Open/Deny confirm (no remember option) and opens a Web tab on Open', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    // setup terminal (1) + agent (2)
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });

    await sendAgentPrompt(page, 'browser_open:https://kibana.corp.com/login log in to read the deploy dashboard');

    const popup = page.locator('.web-perm-overlay');
    await expect(popup).toBeVisible({ timeout: 5_000 });
    // Anti-spoof: the authoritatively-parsed origin is highlighted; the full URL is shown.
    await expect(popup.locator('.web-perm-origin')).toContainText('https://kibana.corp.com');
    await expect(popup.locator('.browser-open-url')).toContainText('https://kibana.corp.com/login');
    // The agent's reason is surfaced (the popup hides the chat where it was said).
    await expect(popup.locator('.browser-open-reason')).toContainText('log in to read the deploy dashboard');

    // ONLY Open + Deny — never a "remember"/"always"/"session" option.
    const options = popup.locator('.agent-perm-option');
    await expect(options).toHaveCount(2);
    await expect(popup.locator('.agent-perm-option', { hasText: 'Open' })).toBeVisible();
    await expect(popup.locator('.agent-perm-option', { hasText: 'Deny' })).toBeVisible();
    await expect(popup.locator('.agent-perm-option', { hasText: /Always|session/i })).toHaveCount(0);

    await popup.locator('.agent-perm-option', { hasText: 'Open' }).click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    // A Web tab was opened, navigated to the login URL, and auto-activated.
    await expect(page.locator('.tab-bar .tab')).toHaveCount(3, { timeout: 5_000 });
    await expect(page.locator('.web-tab-toolbar:visible')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.web-tab-address:visible')).toHaveValue(/kibana\.corp\.com\/login/, { timeout: 5_000 });
  });

  test('Deny opens no tab and surfaces a fail-loud error to the agent', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page);
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });

    await sendAgentPrompt(page, 'browser_open:https://argocd.corp.com/login');

    const popup = page.locator('.web-perm-overlay');
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.locator('.agent-perm-option', { hasText: 'Deny' }).click();
    await expect(popup).not.toBeVisible({ timeout: 5_000 });

    // No Web tab created — still just terminal + agent.
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
    // The tool result is an error the agent can see (echoed by the fake scenario).
    await expect(page.locator('.agent-view:visible')).toContainText('denied by user', { timeout: 5_000 });
  });
});
