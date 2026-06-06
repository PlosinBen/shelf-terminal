import { execSync } from 'child_process';
import { makeShelfAppFixture, openCopilotAgentTab, expect } from './agent-deploy-helpers';

/**
 * Copilot auth-detection E2E: a Copilot agent over a glibc container that has
 * deployed the Copilot CLI but was NEVER `copilot login`-ed.
 *
 * Runs the REAL copilot provider (testMode:false), so gatherCapabilities probes
 * `client.getAuthStatus()`. Logged out → isAuthenticated:false → authRequired →
 * AuthPane. (Verifies the open question: getAuthStatus reports logged-out
 * cleanly in a headless container, rather than throwing.) The signed-IN path
 * needs a GitHub login and is out of scope here.
 */
const test = makeShelfAppFixture('shelf-agent-test-copilot', { testMode: false });
test.setTimeout(300_000);

test('copilot: unauthenticated remote surfaces the AuthPane', async ({ shelfApp: { page } }) => {
  // Idempotent deploy → wipe the root so the CURRENT bundle is copied in.
  try { execSync('docker exec shelf-agent-test-copilot rm -rf /root/.shelf'); } catch { /* noop */ }

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  await openCopilotAgentTab(page);

  const authPane = page.locator('.agent-auth-pane:visible');
  await expect(authPane).toBeVisible({ timeout: 240_000 });
  await expect(authPane).toContainText('Copilot');
  await expect(authPane).toContainText('copilot login');
});
