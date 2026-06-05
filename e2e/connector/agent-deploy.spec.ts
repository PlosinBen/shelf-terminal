import { execSync } from 'child_process';
import { test, expect } from './agent-deploy-helpers';
import { openAgentTab, sendAgentPrompt } from '../helpers';

/**
 * R1 Phase 1.2/1.3 E2E: self-contained agent-server deploy over a Docker
 * connection. Exercises the real chain — probe target (arch×libc) → ensure
 * node+claude cached → docker cp {node,index.mjs,claude} to the versioned root
 * → docker exec `./node index.mjs` (our shipped Node, container has none) →
 * fake-provider turn round-trips.
 *
 * First run downloads node + claude (cached in SHELF_RUNTIME_CACHE_DIR); reruns
 * are fast. Container `shelf-agent-test` is a glibc image with NO node installed.
 */
test.setTimeout(180_000);

test('ships our own Node and runs agent-server over docker (fake provider round-trip)', async ({ shelfApp: { page } }) => {
  // Sanity: the target container has no node of its own — proving we run on ours.
  let containerHasNode = true;
  try {
    execSync(`docker exec shelf-agent-test sh -c 'command -v node'`, { stdio: 'pipe' });
  } catch {
    containerHasNode = false;
  }
  expect(containerHasNode).toBe(false);

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 10_000 });

  await openAgentTab(page);
  // Use the picker scenario: a `.picker-panel` can ONLY appear if the remote
  // agent-server actually ran and emitted picker_request — unlike a text echo,
  // it can't be satisfied by the user's own message bubble. So its presence
  // proves deploy + our-node spawn + round-trip all worked. (Deploy/spawn are
  // lazy on first agent activity → first run also downloads node+claude.)
  await sendAgentPrompt(page, 'picker_single');
  const panel = page.locator('.picker-panel:visible');
  await expect(panel).toBeVisible({ timeout: 150_000 });
  await expect(panel.locator('.picker-option')).toHaveCount(3);
});
