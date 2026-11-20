import { makeShelfAppFixture, assertPickerRoundTrip, containerHasNode, expect } from './agent-deploy-helpers';
import { execFileSync } from 'child_process';
import { NODE_VERSION } from '../../src/main/agent/agent-runtime-versions';

/**
 * R1 glibc path E2E: ship our own Node to a node-less glibc container
 * (`shelf-agent-test`, debian) → docker cp {node,index.mjs,claude} → run
 * `<root>/node index.mjs` → fake picker round-trip.
 *
 * First run downloads node + claude (cached in SHELF_RUNTIME_CACHE_DIR).
 */
const test = makeShelfAppFixture('shelf-agent-test');
test.setTimeout(180_000);

test('glibc: ships our own Node and runs agent-server (no node on the remote)', async ({ shelfApp: { page } }) => {
  expect(containerHasNode('shelf-agent-test')).toBe(false); // proves we run on ours
  await assertPickerRoundTrip(page);
  expect(execFileSync('docker', ['exec', 'shelf-agent-test', 'sh', '-c',
    '/root/.shelf/agent-server/*/node --version'], { encoding: 'utf8' }).trim()).toBe(NODE_VERSION);
});
