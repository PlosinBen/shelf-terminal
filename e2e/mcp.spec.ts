import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

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
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
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

test('mcp: blocks the exact shelf name on add and rename while allowing shelf-tools', async ({ shelfApp: { page, userDataDir } }) => {
  await page.locator('.right-tab-btn', { hasText: 'MCP' }).click();
  const view = page.locator('.mcp-view');
  await expect(view).toBeVisible();
  await view.locator('.mcp-add-btn').click();
  const name = view.locator('.mcp-form-row', { hasText: 'Name' }).locator('input');
  await name.fill('shelf');
  await view.locator('.mcp-form-row', { hasText: 'Command' }).locator('input').fill('node');
  await view.locator('.mcp-form-save').click();
  await expect(view.locator('.mcp-form-error')).toContainText('reserved by Shelf');
  await expect(view.locator('.web-list-item')).toHaveCount(0);

  await name.fill('shelf-tools');
  await view.locator('.mcp-form-save').click();
  const row = view.locator('.web-list-item', { hasText: 'shelf-tools' });
  await expect(row).toBeVisible();
  const configFile = path.join(userDataDir, 'mcp-servers.json');
  const before = fs.readFileSync(configFile, 'utf-8');
  await row.locator('.web-list-action', { hasText: 'Edit' }).click();
  await name.fill('shelf');
  await view.locator('.mcp-form-save').click();
  await expect(view.locator('.mcp-form-error')).toContainText('reserved by Shelf');
  expect(fs.readFileSync(configFile, 'utf-8')).toBe(before);

  await name.fill('Shelf');
  await view.locator('.mcp-form-save').click();
  await expect(view.locator('.web-list-main')).toHaveText('Shelf');
  expect(Object.keys(JSON.parse(fs.readFileSync(configFile, 'utf-8')))).toEqual(['Shelf']);
});

for (const action of ['rename', 'remove'] as const) {
  test(`mcp: keeps a legacy shelf entry visible for ${action}`, async ({ shelfApp: { page, userDataDir } }) => {
    fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
      shelf: { type: 'stdio', command: 'legacy-command' },
    }));
    await page.locator('.right-tab-btn', { hasText: 'MCP' }).click();
    const view = page.locator('.mcp-view');
    const row = view.locator('.web-list-item', { hasText: 'shelf' });
    await expect(row).toBeVisible();
    if (action === 'remove') {
      await row.locator('.web-list-action', { hasText: 'Remove' }).click();
      await expect(view.locator('.web-list-item')).toHaveCount(0);
    } else {
      await row.locator('.web-list-action', { hasText: 'Edit' }).click();
      await view.locator('.mcp-form-row', { hasText: 'Name' }).locator('input').fill('my-shelf');
      await view.locator('.mcp-form-save').click();
      await expect(view.locator('.web-list-main')).toHaveText('my-shelf');
    }
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'mcp-servers.json'), 'utf-8'));
    expect(saved).not.toHaveProperty('shelf');
    expect(saved).toEqual(action === 'rename' ? { 'my-shelf': { type: 'stdio', command: 'legacy-command' } } : {});
  });
}

// T2.3: an MCP config change on a LIVE agent session surfaces a per-tab
// "reconnect to apply" system line (MCP can't hot-reload). Mirrors the skill
// reload feedback test, inverted. Fake provider (SHELF_TEST_MODE=1).
test('mcp: a config change surfaces a "reconnect to apply" line in the live agent view', async ({ shelfApp }) => {
  const { page } = shelfApp;
  await setupProject(page);
  await openAgentTab(page);

  // Make the session live (a no-op notice with no live session emits nothing).
  await sendAgentPrompt(page, 'text:hello');
  await expect(page.locator('.agent-messages')).toContainText('hello', { timeout: 8_000 });

  // Add an MCP server → onMcpChanged → subscriber emits the notice to this tab.
  await addMcpServerViaView(page, 'gamma');

  await expect(page.locator('.agent-msg-system', { hasText: 'reconnect this project to apply' }))
    .toBeVisible({ timeout: 8_000 });
});
