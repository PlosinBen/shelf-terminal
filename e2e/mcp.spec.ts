import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';

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
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
  await page.waitForTimeout(500);
}

async function addMcpServerViaView(page: Page, name: string) {
  await page.locator('.right-tab-btn', { hasText: 'MCP' }).click();
  await expect(page.locator('.mcp-view')).toBeVisible();
  await page.locator('.mcp-add-btn').click();
  await page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input').fill(name);
  await page.locator('.mcp-form-row', { hasText: 'Command' }).locator('input').fill('npx');
  await page.locator('.mcp-form-save').click();
  await expect(page.locator('.web-list-item', { hasText: name })).toBeVisible();
  // Close the panel (toggle off) so it doesn't sit over the agent view assertions.
  await page.locator('.mcp-view .notes-close').click();
}

// The app-level MCP manager, now a right-sidebar view (opened from the BottomBar,
// sibling to Skills). Pure renderer/IPC/store CRUD — no agent needed. Verifies
// add → list → edit(rename) → remove round-trips through the real mcp-store
// (writes the test userDataDir's mcp-servers.json).
//
// Server names are kept distinct from the args summary (and from each other) so
// `.web-list-item` hasText filters match on the NAME, not the command string.

test('mcp: add, edit (rename), and remove a server via the MCP view', async ({ shelfApp }) => {
  const { page } = shelfApp;

  // Open the MCP view from the BottomBar.
  await page.locator('.right-tab-btn', { hasText: 'MCP' }).click();
  await expect(page.locator('.mcp-view')).toBeVisible();
  await expect(page.locator('.mcp-view .right-panel-title', { hasText: 'MCP' })).toBeVisible();
  await expect(page.locator('.mcp-view .web-settings-hint', { hasText: 'No MCP servers configured' })).toBeVisible();

  // Add a stdio server named "alpha".
  await page.locator('.mcp-add-btn').click();
  await page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input').fill('alpha');
  await page.locator('.mcp-form-row', { hasText: 'Command' }).locator('input').fill('npx');
  await page.locator('.mcp-form-row', { hasText: 'Args' }).locator('textarea')
    .fill('-y\n@modelcontextprotocol/server-everything');
  await page.locator('.mcp-form-save').click();

  // It shows in the list with type + summary.
  const alpha = page.locator('.web-list-item', { hasText: 'alpha' });
  await expect(alpha).toBeVisible();
  await expect(alpha.locator('.mcp-list-type')).toHaveText('stdio');
  await expect(alpha.locator('.mcp-list-summary')).toContainText('npx -y @modelcontextprotocol/server-everything');

  // Edit → rename to "beta" (uses nextName under the hood).
  await alpha.locator('.web-list-action', { hasText: 'Edit' }).click();
  const nameInput = page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input');
  await expect(nameInput).toHaveValue('alpha');
  await nameInput.fill('beta');
  await page.locator('.mcp-form-save').click();
  await expect(page.locator('.web-list-item', { hasText: 'beta' })).toBeVisible();
  await expect(page.locator('.web-list-item', { hasText: 'alpha' })).toHaveCount(0);

  // Validation surfaces inline: a stdio server with no command can't be saved.
  await page.locator('.mcp-add-btn').click();
  await page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input').fill('broken');
  await page.locator('.mcp-form-save').click();
  await expect(page.locator('.mcp-form-error')).toContainText('Command is required');
  await page.locator('.mcp-form-cancel').click();

  // Remove the good one → back to empty.
  await page.locator('.web-list-item', { hasText: 'beta' })
    .locator('.web-list-action', { hasText: 'Remove' }).click();
  await expect(page.locator('.web-settings-hint', { hasText: 'No MCP servers configured' })).toBeVisible();
});

// T2.3: an MCP config change on a LIVE agent session surfaces a per-tab
// "reconnect to apply" system line (MCP can't hot-reload). Mirrors the skill
// reload feedback test, inverted. Fake provider (SHELF_TEST_MODE=1).
test('mcp: a config change surfaces a "reconnect to apply" line in the live agent view', async ({ shelfApp }) => {
  const { page } = shelfApp;
  await setupProject(page);
  await openAgentTab(page);

  // Make the session live (a no-op notice with no live session emits nothing).
  await sendAgentPrompt(page, 'text:hello');
  await expect(page.locator('.agent-turn-response')).toContainText('hello', { timeout: 8_000 });

  // Add an MCP server → onMcpChanged → subscriber emits the notice to this tab.
  await addMcpServerViaView(page, 'gamma');

  await expect(page.locator('.agent-msg-system', { hasText: 'reconnect this project to apply' }))
    .toBeVisible({ timeout: 8_000 });
});
