import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openAgentTab } from './helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

function mkdir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shelf-reorder-${label}-`));
}

function project(id: string, name: string) {
  return {
    id,
    name,
    cwd: mkdir(id),
    connection: { type: 'local' },
    maxTabs: 5,
    defaultTabs: [{ name: 'shell' }],
  };
}

function seedProjects(userDataDir: string) {
  fs.writeFileSync(
    path.join(userDataDir, 'projects.json'),
    JSON.stringify([
      project('proj-A', 'Alpha'),
      project('proj-B', 'Bravo'),
      project('proj-C', 'Charlie'),
    ]),
    'utf-8',
  );
}

async function connectProject(page: Page, name: string) {
  await page.locator('.sidebar-item', { hasText: name }).click();
  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 8_000 });
  await expect(page.locator('.terminal-container:visible')).toBeVisible({ timeout: 8_000 });
}

async function dragProject(page: Page, sourceIndex: number, targetIndex: number) {
  await page.evaluate((s) => {
    const src = document.querySelectorAll('.sidebar-item')[s];
    const dt = new DataTransfer();
    dt.setData('text/plain', String(s));
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  }, sourceIndex);
  await page.waitForTimeout(50);
  await page.evaluate((d) => {
    const dst = document.querySelectorAll('.sidebar-item')[d];
    const dt = new DataTransfer();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  }, targetIndex);
}

test.describe('project reorder stable view order', () => {
  let userDataDir: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-reorder-e2e-'));
    seedProjects(userDataDir);
    app = await electron.launch({
      args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SHELF_TEST_MODE: '1', NODE_ENV: 'test' } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 10_000 });
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('dragging the active project does not reinsert its mounted terminal view', async () => {
    await connectProject(page, 'Alpha');
    await connectProject(page, 'Bravo');
    await connectProject(page, 'Charlie');
    await page.locator('.sidebar-item', { hasText: 'Alpha' }).click();
    await expect(page.locator('.terminal-container:visible')).toBeVisible({ timeout: 8_000 });

    await page.evaluate(() => {
      const activeTerminal = document.querySelector('.terminal-container:not([style*="display: none"])');
      const wrapper = activeTerminal?.parentElement;
      const host = wrapper?.parentElement;
      if (!wrapper || !host) throw new Error('active terminal wrapper not found');
      wrapper.setAttribute('data-reorder-active-wrapper', '1');
      (window as unknown as { __activeTerminalReinserted?: boolean }).__activeTerminalReinserted = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const touched = [...record.removedNodes, ...record.addedNodes]
            .some((node) => node === wrapper);
          if (touched) {
            (window as unknown as { __activeTerminalReinserted?: boolean }).__activeTerminalReinserted = true;
          }
        }
      });
      observer.observe(host, { childList: true });
    });

    await dragProject(page, 0, 2);
    await page.waitForTimeout(300);

    await expect(page.locator('.sidebar-item').nth(0)).toContainText('Bravo');
    await expect(page.locator('.sidebar-item').nth(1)).toContainText('Charlie');
    await expect(page.locator('.sidebar-item').nth(2)).toContainText('Alpha');
    await expect(page.locator('[data-reorder-active-wrapper="1"] .terminal-container:visible')).toBeVisible();
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __activeTerminalReinserted?: boolean }).__activeTerminalReinserted),
      { timeout: 1_000 },
    ).toBe(false);
  });

  test('inserting a project before a live agent view does not remount that view', async () => {
    await connectProject(page, 'Alpha');
    await openAgentTab(page);
    await expect(page.locator('.agent-conn-overlay:visible')).toHaveCount(0, { timeout: 8_000 });

    await page.evaluate(() => {
      const agent = document.querySelector('.agent-view:not([style*="display: none"])');
      const wrapper = agent?.parentElement;
      const host = wrapper?.parentElement;
      if (!wrapper || !host) throw new Error('active agent wrapper not found');
      wrapper.setAttribute('data-insertion-agent-wrapper', '1');
      (window as unknown as { __agentViewReinserted?: boolean }).__agentViewReinserted = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const touched = [...record.removedNodes, ...record.addedNodes]
            .some((node) => node === wrapper);
          if (touched) {
            (window as unknown as { __agentViewReinserted?: boolean }).__agentViewReinserted = true;
          }
        }
      });
      observer.observe(host, { childList: true });
    });

    // FolderPicker generates `proj-<timestamp>`, which sorts before the seeded
    // `proj-A`/`proj-B`/`proj-C` ids in listStableProjectViews. That inserts a
    // new outer project group before Alpha without touching Alpha itself.
    await page.locator('.sidebar-btn', { hasText: '+' }).click();
    await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
    await page.locator('.conn-btn-next').click();
    await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
    await page.keyboard.press(`${modifier}+Enter`);
    await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

    await expect(page.locator('[data-insertion-agent-wrapper="1"]')).toHaveCount(1);
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __agentViewReinserted?: boolean }).__agentViewReinserted),
      { timeout: 1_000 },
    ).toBe(false);
  });
});
