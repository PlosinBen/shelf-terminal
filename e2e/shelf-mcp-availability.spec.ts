import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setupProject(page: import('@playwright/test').Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible();
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
}

// Wire-level UI coverage using the fake provider; actual bootstrap failure and
// provider config omission are covered by backend integration/unit tests.
test('Shelf failure stays visible while conversation, clear and auth remain usable', async ({ shelfApp: { page } }) => {
  await setupProject(page);
  await openAgentTab(page);
  const banner = page.locator('.agent-shelf-mcp-banner:visible');
  await expect(banner).toHaveCount(0);
  await sendAgentPrompt(page, 'shelf_mcp:authorization|text:conversation still works');
  await expect(banner).toContainText('Authorization failed');
  await expect(banner).toContainText('This Agent remains usable');
  await expect(banner.locator('button')).toHaveCount(0);
  await expect(page.locator('.agent-msg:visible').last()).toContainText('conversation still works');

  // Conversation clear does not alter exec-owned startup state.
  await sendAgentPrompt(page, '/clear');
  await expect(banner).toBeVisible();
  await sendAgentPrompt(page, 'text:still usable after clear');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('still usable after clear');
  await sendAgentPrompt(page, 'auth_required');
  await expect(page.locator('.agent-textarea:visible')).toHaveCount(0);
  await expect(banner).toBeVisible();
});

test('only explicit startup success clears the warning, and status is tab-local', async ({ shelfApp: { page } }) => {
  await setupProject(page);
  await openAgentTab(page);
  await sendAgentPrompt(page, 'shelf_mcp:listener|text:ready');
  await expect(page.locator('.agent-shelf-mcp-banner:visible')).toContainText('Local endpoint could not start');
  // An independent Agent must not inherit another tab's failure.
  await page.locator('.tab-add').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
  await expect(page.locator('.agent-textarea:visible')).toBeEnabled();
  await expect(page.locator('.agent-shelf-mcp-banner:visible')).toHaveCount(0);
  await page.locator('.tab-bar .tab', { hasText: 'Claude' }).click();
  await expect(page.locator('.agent-shelf-mcp-banner:visible')).toBeVisible();
  await sendAgentPrompt(page, 'shelf_mcp:available|text:restored');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('restored');
  await expect(page.locator('.agent-shelf-mcp-banner')).toHaveCount(0);
});
