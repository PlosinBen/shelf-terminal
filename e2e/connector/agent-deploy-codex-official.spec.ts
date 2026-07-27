import {
  makeShelfAppFixture,
  assertPickerRoundTrip,
  openCodexOfficialAgentTab,
  deployedFileTree,
  expect,
} from './agent-deploy-helpers';

/**
 * Official Codex SDK provider deploy coverage.
 *
 * SHELF_TEST_MODE keeps the backend fake after deploy, so this proves provider
 * selection + self-contained runtime shipping without requiring real OpenAI auth.
 * The official SDK JS is bundled in agent-server; the deployed side only needs
 * the pinned Codex CLI/native tree.
 */
const test = makeShelfAppFixture('shelf-agent-test');
test.setTimeout(300_000);

test('codex official: deploys the shared Codex CLI/native runtime without codex-sdk resources', async ({ shelfApp: { page } }) => {
  await assertPickerRoundTrip(page, openCodexOfficialAgentTab);

  const files = deployedFileTree('shelf-agent-test');
  expect(files).toContain('node');
  expect(files).toContain('index.mjs');
  expect(files).toContain('codex-cli/node_modules/@openai/codex/bin/codex.js');
  expect(files.some((file) => /codex-cli\/node_modules\/@openai\/codex-linux-(x64|arm64)\/vendor\/[^/]+\/bin\/codex$/.test(file))).toBe(true);
  expect(files.some((file) => file.includes('@openai/codex-sdk'))).toBe(false);
});
