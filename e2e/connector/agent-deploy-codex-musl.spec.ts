import { makeShelfAppFixture, openCodexAgentTab, expect } from './agent-deploy-helpers';

const test = makeShelfAppFixture('shelf-agent-test-musl', { testMode: false });
test.setTimeout(120_000);

test('codex: musl remote fails loudly before transfer or spawn', async ({ shelfApp: { page } }) => {
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  await openCodexAgentTab(page);
  const overlay = page.locator('.agent-conn-overlay:visible');
  await expect(overlay).toContainText('Failed to start agent', { timeout: 60_000 });
  await expect(overlay).toContainText('Codex requires a glibc host');
});
