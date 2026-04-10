import { test, expect } from './ssh-helpers';
import { SSH_TEST } from './ssh-config';

test.setTimeout(60_000);

test('SSH terminal connects and shows output', async ({ shelfApp: { page } }) => {
  // Connect to the pre-seeded SSH project
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }

  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 15_000 });

  // Wait for terminal to be ready — remote shell prompt
  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.waitForTimeout(3000);

  // Type a command and verify output
  await page.keyboard.type('echo __SSH_E2E_TEST__\n');
  await expect(xtermRows).toContainText('__SSH_E2E_TEST__', { timeout: 10_000 });
});

test('SSH ControlMaster multiplexing — second tab connects instantly', async ({ shelfApp: { page } }) => {
  // First tab should already be connected from previous test
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  // Open second tab
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+t`);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });

  // Click second tab
  await page.locator('.tab-bar .tab').nth(1).click();
  await page.waitForTimeout(3000);

  // Second tab should connect without password prompt (ControlMaster reuse)
  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.keyboard.type('echo __SSH_TAB2__\n');
  await expect(xtermRows).toContainText('__SSH_TAB2__', { timeout: 5_000 });
});

test('SSH image SCP to remote host', async ({ shelfApp: { page } }) => {
  // Create a minimal 1x1 PNG in the renderer and call the preload API
  const remotePath = await page.evaluate(async () => {
    // Minimal valid 1x1 PNG
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    return window.shelfApi.clipboard.saveImageRemote(
      png.buffer, '127.0.0.1', 2222, 'testuser',
    );
  });

  expect(remotePath).toMatch(/^\/tmp\/shelf-paste\/paste-\d+\.png$/);
});

test('SSH disconnect and reconnect', async ({ shelfApp: { page } }) => {
  // Ensure connected first
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await prompt.click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(3000);
  }

  // Right-click project in sidebar → Disconnect
  const sidebarItem = page.locator('.sidebar-item').first();
  await sidebarItem.click({ button: 'right' });

  const disconnectBtn = page.locator('.context-menu-item', { hasText: 'Disconnect' });
  await expect(disconnectBtn).toBeVisible({ timeout: 3_000 });
  await disconnectBtn.click();

  // Should show connect prompt (no tabs)
  await expect(page.locator('.tab-bar .tab')).toHaveCount(0, { timeout: 5_000 });
  const reconnectPrompt = page.locator('.connect-prompt');
  await expect(reconnectPrompt).toBeVisible({ timeout: 5_000 });

  // Reconnect
  await reconnectPrompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 15_000 });

  // Verify terminal works
  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.waitForTimeout(3000);
  await page.keyboard.type('echo __SSH_RECONNECT__\n');
  await expect(xtermRows).toContainText('__SSH_RECONNECT__', { timeout: 10_000 });
});
