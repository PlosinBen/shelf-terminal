import { execSync } from 'child_process';
import { makeShelfAppFixture, openCodexAgentTab, expect } from './agent-deploy-helpers';

const test = makeShelfAppFixture('shelf-agent-test', { testMode: false });
test.setTimeout(300_000);

test('codex: unauthenticated glibc remote deploy reaches the AuthPane', async ({ shelfApp: { page } }, testInfo) => {
  try { execSync('docker exec shelf-agent-test rm -rf /root/.shelf'); } catch { /* noop */ }
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  await openCodexAgentTab(page);
  const authPane = page.locator('.agent-auth-pane:visible');
  const overlay = page.locator('.agent-conn-overlay:visible');
  const textarea = page.locator('.agent-textarea:visible');

  // Preserve the actual pane state before judging the auth outcome. A missing
  // AuthPane could mean authenticated-and-ready, init failure, or a stuck init;
  // treating all three as the same 240s timeout hides the root cause.
  for (let elapsed = 0; elapsed < 30_000; elapsed += 250) {
    const overlayText = await overlay.textContent().catch(() => null);
    if (await authPane.isVisible() || overlayText?.includes('Failed to start agent') || (!await overlay.isVisible() && await textarea.isVisible())) break;
    await page.waitForTimeout(250);
  }
  if (!await authPane.isVisible()) {
    const overlayText = await overlay.textContent().catch(() => null);
    const screenshot = await page.screenshot();
    await testInfo.attach('codex-pane-before-auth', { body: screenshot, contentType: 'image/png' });
    throw new Error(`Codex did not reach AuthPane: overlay=${JSON.stringify(overlayText)} textarea=${await textarea.isVisible()}`);
  }
  await expect(authPane).toBeVisible({ timeout: 240_000 });
  await expect(authPane).toContainText('Codex');
});
