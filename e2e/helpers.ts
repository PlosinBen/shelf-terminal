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
export const test = base.extend<{}, { shelfApp: { app: ElectronApplication; page: Page } }>({
  shelfApp: [async ({}, use) => {
    const userDataDir = createTempUserDataDir();
    seedProjectsData(userDataDir);
    ensureTestDirectories();

    // SHELF_TEST_MODE=1 swaps every agent-server backend lookup for the fake
    // provider (agent-server/providers/fake.ts) so renderer specs can drive
    // the full wire chain without real Claude/Copilot SDKs. Toggle per worker
    // — once set here, all specs sharing the worker see the fake provider.
    const app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1' },
    });

    let page: Page;
    try {
      page = await app.firstWindow();
      await page.waitForSelector('.app', { timeout: 10_000 });
    } catch (err) {
      await app.close().catch(() => {});
      throw err;
    }

    await use({ app, page });

    // Always runs — even after test failures
    await app.close().catch(() => {});
    cleanupTestDirectories();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }, { scope: 'worker' }],
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
  // Worker-scoped fixture means previous tests' agent-views may still be in
  // the DOM under other projects. Match only the visible one (active tab).
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
