import { assertPickerRoundTrip, expect } from './agent-deploy-helpers';
import { makeWslShelfAppFixture, wslDeployedFiles, WSL_TEST_DISTRO } from './agent-deploy-wsl-helpers';

/**
 * R1 WSL path E2E — runs ONLY on a Windows host (needs `wsl.exe`). Mirrors the
 * docker glibc spec but over a real WSL distro: deploy {node,index.mjs,claude}
 * to `$HOME/.shelf/agent-server/<version>/` via wsl.exe → run `<root>/node
 * index.mjs` → fake picker round-trip.
 *
 * Distro via SHELF_WSL_TEST_DISTRO (default 'Ubuntu' = glibc → we ship our own
 * node). For an Alpine/musl distro the deployedFiles assertion inverts: it would
 * NOT ship node (uses the remote's), shipping only index.mjs + claude.
 *
 * Run with: npm run test:agent-deploy-wsl
 * First run downloads node + claude (cached in SHELF_RUNTIME_CACHE_DIR).
 */
const test = makeWslShelfAppFixture(WSL_TEST_DISTRO);
test.setTimeout(180_000);

test('wsl glibc: ships our own Node and runs agent-server over wsl.exe', async ({ shelfApp: { page } }) => {
  await assertPickerRoundTrip(page);

  // glibc → we ship our own node alongside index.mjs + the claude binary.
  const files = wslDeployedFiles(WSL_TEST_DISTRO);
  expect(files).toContain('node');
  expect(files).toContain('index.mjs');
  expect(files).toContain('claude');
});
