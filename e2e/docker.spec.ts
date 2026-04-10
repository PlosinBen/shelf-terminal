import { test, expect } from './docker-helpers';

test.setTimeout(30_000);

test('Docker terminal connects and shows output', async ({ shelfApp: { page } }) => {
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }

  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.waitForTimeout(2000);

  await page.keyboard.type('echo __DOCKER_E2E__\n');
  await expect(xtermRows).toContainText('__DOCKER_E2E__', { timeout: 10_000 });
});

test('Docker second tab connects', async ({ shelfApp: { page } }) => {
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+t`);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });

  await page.locator('.tab-bar .tab').nth(1).click();
  await page.waitForTimeout(3000);

  await page.locator('.terminal-container:visible .xterm-screen').click({ force: true });
  await page.waitForTimeout(500);

  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.keyboard.type('echo __DOCKER_TAB2__\n');
  await expect(xtermRows).toContainText('__DOCKER_TAB2__', { timeout: 10_000 });
});

test('Docker image copy to container', async ({ shelfApp: { page } }) => {
  const remotePath = await page.evaluate(async () => {
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
    return window.shelfApi.clipboard.saveImageDocker(png.buffer, 'shelf-test-container');
  });

  expect(remotePath).toMatch(/^\/tmp\/shelf-paste\/paste-\d+\.png$/);
});

test('Docker disconnect and reconnect', async ({ shelfApp: { page } }) => {
  // Ensure connected
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await prompt.click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });
    await page.waitForTimeout(2000);
  }

  // Disconnect
  const sidebarItem = page.locator('.sidebar-item').first();
  await sidebarItem.click({ button: 'right' });
  const disconnectBtn = page.locator('.context-menu-item', { hasText: 'Disconnect' });
  await expect(disconnectBtn).toBeVisible({ timeout: 3_000 });
  await disconnectBtn.click();

  await expect(page.locator('.tab-bar .tab')).toHaveCount(0, { timeout: 5_000 });
  const reconnectPrompt = page.locator('.connect-prompt');
  await expect(reconnectPrompt).toBeVisible({ timeout: 5_000 });

  // Reconnect
  await reconnectPrompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.waitForTimeout(2000);
  await page.keyboard.type('echo __DOCKER_RECONNECT__\n');
  await expect(xtermRows).toContainText('__DOCKER_RECONNECT__', { timeout: 10_000 });
});
