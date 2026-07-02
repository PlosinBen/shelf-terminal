import { test as base, type ElectronApplication, type Page, _electron as electron, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

function createTempUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-e2e-'));
}

function seedProjectsData(userDataDir: string) {
  fs.writeFileSync(path.join(userDataDir, 'projects.json'), '[]', 'utf-8');
}

/** Ensure home directory has enough subdirectories for folder picker tests */
function ensureTestDirectories() {
  const home = os.homedir();
  for (const name of ['shelf-test-a', 'shelf-test-b', 'shelf-test-c']) {
    const dir = path.join(home, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  }
}

function cleanupTestDirectories() {
  const home = os.homedir();
  for (const name of ['shelf-test-a', 'shelf-test-b', 'shelf-test-c']) {
    const dir = path.join(home, name);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  }
}

/**
 * Custom test fixture that guarantees Electron is killed even on failure.
 */
/**
 * Per-test scoped fixture: each test gets a fresh Electron launch + tempdir.
 *
 * Trade-off: ~3s startup × N tests adds to total run time (~3 min on the
 * full suite), but eliminates cross-test state leaks that previously made
 * `app-startup.spec.ts:22 no projects on fresh start` order-dependent —
 * it expected 0 sidebar items but inherited 4 from prior tests that ran
 * setupProject. Worker-scope was a premature optimization.
 *
 * SHELF_TEST_MODE=1 swaps every agent-server backend lookup for the fake
 * provider (agent-server/providers/fake.ts) so renderer specs can drive
 * the full wire chain without real Claude/Copilot SDKs.
 */
export const test = base.extend<{
  // Opt-in: when a spec does `test.use({ capsFail: true })`, the agent-server
  // fake provider's gatherCapabilities throws (SHELF_TEST_CAPS_FAIL=1), driving
  // the init-'failed' path so a spec can assert the input-readiness gate. Default
  // false leaves every other spec's launch env unchanged.
  capsFail: boolean;
  shelfApp: { app: ElectronApplication; page: Page; userDataDir: string };
}>({
  capsFail: [false, { option: true }],
  shelfApp: async ({ capsFail }, use) => {
    const userDataDir = createTempUserDataDir();
    seedProjectsData(userDataDir);
    ensureTestDirectories();

    const app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      // NODE_ENV=test keeps the main window hidden (index.ts: `show: NODE_ENV
      // !== 'test'`) so e2e launches don't steal macOS foreground focus. Set it
      // HERE (not only via the `NODE_ENV=test npx playwright` npm script) so a
      // bare `npx playwright test` invocation still gets hidden windows.
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test', ...(capsFail ? { SHELF_TEST_CAPS_FAIL: '1' } : {}) },
    });

    let page: Page;
    try {
      page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
    } catch (err) {
      await app.close().catch(() => {});
      throw err;
    }

    await use({ app, page, userDataDir });

    // Always runs — even after test failures
    await app.close().catch(() => {});
    cleanupTestDirectories();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';

/**
 * Open a Claude agent tab on the active project. Assumes a project is already
 * created and visible in the sidebar (use `setupProject` from the calling
 * spec). Right-clicks the `+` tab-add button to open the kind menu, then
 * clicks "Agent (Claude)".
 *
 * In SHELF_TEST_MODE the renderer still sees `provider='claude'`, but the
 * agent-server swaps the backend for the fake provider — so prompts use
 * the fake-provider scenario syntax (`text:`, `picker_single`, etc.).
 */
export async function openAgentTab(page: Page): Promise<void> {
  const addBtn = page.locator('.tab-add');
  await addBtn.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();
  // `:visible` defends against transient stacking during tab switch and
  // any future fixture-scope changes; harmless under per-test fixture.
  await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-textarea:visible')).toBeVisible();
}

/**
 * Type a fake-provider scenario into the agent input and submit. Scenarios
 * are documented in `agent-server/providers/fake.ts`.
 */
export async function sendAgentPrompt(page: Page, scenario: string): Promise<void> {
  // `:visible` discipline as in openAgentTab — active project's textarea only.
  const ta = page.locator('.agent-textarea:visible');
  await ta.click();
  await ta.fill(scenario);
  await ta.press('Enter');
}

export async function readActiveTerminalText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const cache = (window as unknown as { __shelfTerminalCache__?: Map<string, any> }).__shelfTerminalCache__;
    const visible = Array.from(document.querySelectorAll('.terminal-container'))
      .find((c) => (c as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
    if (!cache || !visible) return '';
    for (const [, cached] of cache) {
      if (cached.term?.element && visible.contains(cached.term.element)) {
        const buf = cached.term.buffer.active;
        let out = '';
        for (let y = 0; y < buf.length; y++) {
          const line = buf.getLine(y);
          if (line) out += line.translateToString(true) + '\n';
        }
        return out;
      }
    }
    return '';
  });
}
