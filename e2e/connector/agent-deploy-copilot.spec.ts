import {
  makeShelfAppFixture,
  assertPickerRoundTrip,
  openCopilotAgentTab,
  deployedFiles,
  expect,
} from './agent-deploy-helpers';

/**
 * R1 Phase 2 (deploy slice) E2E: a COPILOT agent over a glibc container ships
 * the Copilot CLI binary (provider-aware deploy) — NOT claude. Proves deploy
 * picks the right per-provider binary.
 *
 * NOTE: SHELF_TEST_MODE swaps the runtime backend to fake, so the Copilot
 * binary is deployed but NOT actually executed here. A real Copilot turn needs
 * a GitHub login (the Copilot CLI's own login via useLoggedInUser — NOT the gh
 * command). This validates deploy + round-trip wiring; real Copilot execution
 * is verified separately on a GitHub-authenticated environment.
 */
const test = makeShelfAppFixture('shelf-agent-test-copilot');
test.setTimeout(180_000);

test('copilot: provider-aware deploy ships the copilot binary (not claude)', async ({ shelfApp: { page } }) => {
  await assertPickerRoundTrip(page, openCopilotAgentTab);

  const files = deployedFiles('shelf-agent-test-copilot');
  expect(files).toContain('index.mjs');
  expect(files).toContain('node'); // glibc → we ship node
  expect(files).toContain('copilot'); // provider binary
  expect(files).not.toContain('claude'); // claude NOT shipped for a copilot agent
});
