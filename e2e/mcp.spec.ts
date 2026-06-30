import { test, expect } from './helpers';

// Settings → MCP tab: the app-level MCP manager (T1.2). Pure renderer/IPC/store
// CRUD — no agent needed. Verifies add → list → edit(rename) → remove round-trips
// through the real mcp-store (writes the test userDataDir's mcp-servers.json).

test('mcp: add, edit (rename), and remove a server via Settings → MCP', async ({ shelfApp }) => {
  const { page } = shelfApp;

  // Open Settings → MCP.
  await page.locator('.sidebar-btn[title*="Settings"]').click();
  await expect(page.locator('.settings-panel')).toBeVisible();
  await page.locator('.settings-tab', { hasText: 'MCP' }).click();
  await expect(page.locator('.web-settings-title', { hasText: 'MCP servers' })).toBeVisible();
  await expect(page.locator('.web-settings-hint', { hasText: 'No MCP servers configured' })).toBeVisible();

  // Add a stdio server.
  await page.locator('.mcp-add-btn').click();
  await page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input').fill('everything');
  await page.locator('.mcp-form-row', { hasText: 'Command' }).locator('input').fill('npx');
  await page.locator('.mcp-form-row', { hasText: 'Args' }).locator('textarea')
    .fill('-y\n@modelcontextprotocol/server-everything');
  await page.locator('.mcp-form-save').click();

  // It shows in the list with type + summary.
  const item = page.locator('.web-list-item', { hasText: 'everything' });
  await expect(item).toBeVisible();
  await expect(item.locator('.mcp-list-type')).toHaveText('stdio');
  await expect(item.locator('.mcp-list-summary')).toContainText('npx -y @modelcontextprotocol/server-everything');

  // Edit → rename to "every2" (uses nextName under the hood).
  await item.locator('.web-list-action', { hasText: 'Edit' }).click();
  const nameInput = page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input');
  await expect(nameInput).toHaveValue('everything');
  await nameInput.fill('every2');
  await page.locator('.mcp-form-save').click();
  await expect(page.locator('.web-list-item', { hasText: 'every2' })).toBeVisible();
  await expect(page.locator('.web-list-item', { hasText: 'everything' })).toHaveCount(0);

  // Validation surfaces inline: a stdio server with no command can't be saved.
  await page.locator('.mcp-add-btn').click();
  await page.locator('.mcp-form-row', { hasText: 'Name' }).locator('input').fill('broken');
  await page.locator('.mcp-form-save').click();
  await expect(page.locator('.mcp-form-error')).toContainText('Command is required');
  await page.locator('.mcp-form-cancel').click();

  // Remove the good one → back to empty.
  await page.locator('.web-list-item', { hasText: 'every2' })
    .locator('.web-list-action', { hasText: 'Remove' }).click();
  await expect(page.locator('.web-settings-hint', { hasText: 'No MCP servers configured' })).toBeVisible();
});
