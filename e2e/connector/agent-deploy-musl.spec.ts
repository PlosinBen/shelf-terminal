import {
  makeShelfAppFixture,
  assertPickerRoundTrip,
  containerHasNode,
  deployedFiles,
  expect,
} from './agent-deploy-helpers';

/**
 * R1 musl path E2E: against `shelf-agent-test-musl` (node:alpine — musl + its
 * own node). We do NOT ship Node here; we ship only index.mjs + claude (the
 * `-musl` companion) and run agent-server on the remote's node. Proves the
 * "use remote node" path works on Alpine and avoids the regression of rejecting
 * musl outright.
 */
const test = makeShelfAppFixture('shelf-agent-test-musl');
test.setTimeout(180_000);

test('musl: uses the remote node and ships no node of our own', async ({ shelfApp: { page } }) => {
  expect(containerHasNode('shelf-agent-test-musl')).toBe(true); // node:alpine has node

  await assertPickerRoundTrip(page);

  // We shipped index.mjs + claude but NOT node (musl uses the remote's node).
  const files = deployedFiles('shelf-agent-test-musl');
  expect(files).toContain('index.mjs');
  expect(files).toContain('claude');
  expect(files).not.toContain('node');
});
