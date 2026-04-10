import { test, expect } from './ssh-helpers';

test.setTimeout(60_000);

test('SSH password auth establishes ControlMaster and runs commands', async ({ shelfApp: { page } }) => {
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

test('SSH ControlMaster multiplexes second session without re-auth', async ({ shelfApp: { page } }) => {
  // First tab should already be connected from previous test
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });

  // Open second tab — should not prompt for password (ControlMaster reuse)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+t`);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });

  await page.locator('.tab-bar .tab').nth(1).click();
  await page.waitForTimeout(3000);

  await page.locator('.terminal-container:visible .xterm-screen').click({ force: true });
  await page.waitForTimeout(500);

  const xtermRows = page.locator('.terminal-container:visible .xterm-rows');
  await page.keyboard.type('echo __SSH_TAB2__\n');
  await expect(xtermRows).toContainText('__SSH_TAB2__', { timeout: 10_000 });
});

test('uploadFile streams a file to the remote host via SSH ControlMaster', async ({ shelfApp: { page } }) => {
  const result = await page.evaluate(async () => {
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
    return window.shelfApi.connector.uploadFile(
      { type: 'ssh', host: '127.0.0.1', port: 2222, user: 'testuser' },
      '/tmp',
      'paste.png',
      png.buffer,
    );
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.remotePath).toMatch(/^\/tmp\/\.tmp\/shelf\/[a-z0-9]+-paste\.png$/);
  }
});
