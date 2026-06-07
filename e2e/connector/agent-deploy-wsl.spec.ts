import { readFileSync } from 'fs';
import path from 'path';
import { assertPickerRoundTrip, expect } from './agent-deploy-helpers';
import { openAgentTab, sendAgentPrompt } from '../helpers';
import {
  makeWslShelfAppFixture,
  wslDeployedFiles,
  wslCleanDeployRoot,
  wslDeployedNodeMtime,
  WSL_TEST_DISTRO,
} from './agent-deploy-wsl-helpers';

// The deploy root is versioned (`agent-server/<version>/`); use the SAME version
// the app derives from package.json (getAppVersion reads app.getAppPath() —
// here the repo root) so we clean/inspect only this version's dir.
const VERSION: string = JSON.parse(
  readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
).version;

/**
 * R1 WSL path E2E — runs ONLY on a Windows host (needs `wsl.exe`). Mirrors the
 * docker glibc spec but over a real WSL distro, and additionally verifies the
 * self-contained deploy's core contract: ship once, then reuse.
 *
 *   1st connection  → fresh deploy: ship {node,index.mjs,claude} to
 *                     `$HOME/.shelf/agent-server/<version>/` via wsl.exe.
 *   2nd connection  → `.deployed` sentinel present → deploy SKIPPED, the ~215MB
 *                     node/claude are NOT re-copied (asserted via unchanged mtime).
 *
 * Distro via SHELF_WSL_TEST_DISTRO (default 'Ubuntu' = glibc → we ship our own
 * node). For an Alpine/musl distro the file set inverts: no node shipped (uses
 * the remote's), only index.mjs + claude.
 *
 * Run with: npm run test:agent-deploy-wsl
 * First run downloads node + claude (cached in SHELF_RUNTIME_CACHE_DIR).
 */
const test = makeWslShelfAppFixture(WSL_TEST_DISTRO);
test.setTimeout(180_000);

test('wsl glibc: first connection deploys, second reuses (no re-copy)', async ({ shelfApp: { page } }) => {
  // Clean slate so the first connection genuinely performs a fresh deploy.
  wslCleanDeployRoot(VERSION, WSL_TEST_DISTRO);
  expect(wslDeployedFiles(VERSION, WSL_TEST_DISTRO)).toHaveLength(0);

  // 1st connection → ships our own node + index.mjs + claude (glibc path).
  await assertPickerRoundTrip(page);
  const files = wslDeployedFiles(VERSION, WSL_TEST_DISTRO);
  expect(files).toContain('node');
  expect(files).toContain('index.mjs');
  expect(files).toContain('claude');
  const mtimeAfterFirst = wslDeployedNodeMtime(VERSION, WSL_TEST_DISTRO);
  expect(mtimeAfterFirst).not.toBe('');

  // 2nd connection: only one Claude agent tab is allowed per project, so close
  // the agent tab and reopen it — a FRESH backend re-runs the deploy check,
  // which now finds the `.deployed` sentinel and SKIPS, so the shipped node is
  // NOT re-copied. (The agent tab is active after the round-trip above.)
  await page.locator('.tab.active .tab-close').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);

  await openAgentTab(page);
  await sendAgentPrompt(page, 'picker_single');
  const panel = page.locator('.picker-panel:visible');
  await expect(panel).toBeVisible({ timeout: 150_000 });
  await expect(panel.locator('.picker-option')).toHaveCount(3);

  expect(wslDeployedNodeMtime(VERSION, WSL_TEST_DISTRO)).toBe(mtimeAfterFirst);
});
