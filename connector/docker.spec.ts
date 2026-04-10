import { test, expect } from './docker-helpers';

test.setTimeout(30_000);

test('Docker exec spawns terminal and runs commands', async ({ shelfApp: { page } }) => {
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

test('uploadFile streams a file into the container via docker exec', async ({ shelfApp: { page } }) => {
  const result = await page.evaluate(async () => {
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
      { type: 'docker', container: 'shelf-test-container' },
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
