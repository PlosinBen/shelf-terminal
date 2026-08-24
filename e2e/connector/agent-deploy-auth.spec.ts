import { execSync } from 'child_process';
import { makeShelfAppFixture, expect } from './agent-deploy-helpers';
import { openAgentTab } from '../helpers';

/**
 * R1 auth-detection E2E (doubles as the logged-out spike): a Claude agent over
 * a glibc container that has deployed claude but was NEVER `claude login`-ed.
 *
 * Unlike the other agent-deploy specs, this runs the REAL claude provider
 * (testMode:false → no SHELF_TEST_MODE), so ensureInit performs a genuine SDK
 * `auth status --json` probe against the unauthenticated binary. With no
 * ~/.claude credentials, it returns loggedIn:false → auth-failed →
 * gatherCapabilities.authRequired → AuthPane takes over the chat pane.
 *
 * This is the only end-to-end exercise of the real auth detection against a
 * genuinely logged-out claude. It protects the warmup gate specifically: the
 * textarea must not remain usable until a real prompt discovers auth failure.
 */
const test = makeShelfAppFixture('shelf-agent-test', { testMode: false });
// First run downloads our node + the claude binary (~200MB) into the runtime
// cache, then deploys to the container, then runs the SDK init probe.
test.setTimeout(300_000);

test('claude: unauthenticated remote surfaces the AuthPane', async ({ shelfApp: { page } }) => {
  // Force a fresh deploy of the CURRENT bundle: the deploy is idempotent
  // (`.deployed` sentinel), so a persisted container would keep running a stale
  // index.mjs. Wipe its deploy root so the current agent-server is copied in.
  try { execSync('docker exec shelf-agent-test rm -rf /root/.shelf'); } catch { /* noop */ }

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  // Opening the tab triggers deploy → spawn → CLI auth-status probe. The textarea is
  // visible during the 'starting' phase (before the probe resolves); once the
  // probe reports auth-failed, AgentView swaps the whole pane for AuthPane.
  await openAgentTab(page);

  const authPane = page.locator('.agent-auth-pane:visible');
  await expect(authPane).toBeVisible({ timeout: 240_000 });
  // sdk-managed kind → current terminal command + verification action.
  await expect(authPane).toContainText('Claude');
  await expect(authPane).toContainText('claude auth login');
  await expect(authPane.locator('.agent-reset-btn', { hasText: 'Check again' })).toBeVisible();
});
