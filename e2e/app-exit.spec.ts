import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import { IPC } from '../src/shared/ipc-channels';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function setup(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();
  await page.locator('.connect-prompt').click();
  await openAgentTab(page);
  await page.locator('.tab-bar .tab').last().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Save to Default', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs.length).toBe(2);
}

async function quit(app: ElectronApplication, windowClose = false) {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app, BrowserWindow }, closeWindow) => {
    if (closeWindow) BrowserWindow.getAllWindows()[0].close();
    else app.quit();
  }, windowClose);
  await closed;
}

async function restored(userDataDir: string, verify: (page: Page) => Promise<void>) {
  const app = await electron.launch({ args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`], env: { ...process.env, NODE_ENV: 'test', SHELF_TEST_MODE: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    await page.locator('.sidebar-item').first().click();
    await page.locator('.connect-prompt').click();
    await page.locator('.tab-bar .tab').nth(1).click();
    await verify(page);
  } finally { await app.close(); }
}

test('Quit persists recent messages without waiting for the history throttle', async ({ shelfApp: { app, page, userDataDir } }) => {
  await setup(page);
  await sendAgentPrompt(page, 'text:immediate-quit-history');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('immediate-quit-history');
  // No five-second sleep or durable-history polling: exit itself owns the flush.
  await quit(app);
  await restored(userDataDir, async next => {
    await expect(next.locator('.agent-msg:visible', { hasText: 'immediate-quit-history' }).last()).toBeVisible();
  });
});

test('window close snapshots an active stream as interrupted without waiting for the model', async ({ shelfApp: { app, page, userDataDir } }) => {
  await setup(page);
  await sendAgentPrompt(page, 'chunk:partial-before-close|delay:60000');
  await expect(page.locator('.agent-msg:visible', { hasText: 'partial-before-close' }).last()).toBeVisible();
  await expect(page.locator('.agent-status-label:visible')).not.toHaveText('idle');
  await quit(app, true);
  await restored(userDataDir, async next => {
    const reply = next.locator('.agent-msg-reply:visible', { hasText: 'partial-before-close' });
    await expect(reply).toContainText('Interrupted when Shelf exited');
    await expect(reply.locator('.agent-cursor')).toHaveCount(0);
  });
});

test('cancel after save failure keeps the same View usable and retains retry data', async ({ shelfApp: { app, page } }) => {
  await setup(page);
  await sendAgentPrompt(page, 'chunk:before-cancel|delay:2500|text:continued-after-cancel');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('before-cancel');
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__exitPrompts = 0;
    (dialog as any).showMessageBox = async (options: { title?: string; defaultId?: number }) => {
      if (options.title === 'Could not save Agent history') {
        (globalThis as any).__exitPrompts++;
        if (options.defaultId !== 0) throw new Error('Exit failure must default to cancellation');
      }
      return { response: 0, checkboxChecked: false };
    };
  });
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    (window as any).__restoreExitWrites = () => { IDBDatabase.prototype.transaction = original; };
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (this.name === 'shelf-agent-history' && args[1] === 'readwrite') throw new Error('simulated exit save failure');
      return original.apply(this, args);
    };
  });
  try {
    await app.evaluate(({ app }) => app.quit());
    await expect.poll(() => app.evaluate(() => (globalThis as any).__exitPrompts)).toBe(1);
  } finally { await page.evaluate(() => (window as any).__restoreExitWrites()); }
  await expect(page.locator('.app-exit-overlay')).toHaveCount(0);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  await expect(page.locator('.agent-msg-reply:visible', { hasText: 'continued-after-cancel' }).last()).toBeVisible();
  await sendAgentPrompt(page, 'text:usable-after-cancel');
  await expect(page.locator('.agent-msg-reply:visible', { hasText: 'usable-after-cancel' }).last()).toBeVisible();
  await expect(page.locator('.agent-msg:visible', { hasText: 'before-cancel' }).last()).toBeVisible();
});

test('Retry performs a new save and only then permits Quit', async ({ shelfApp: { app, page, userDataDir } }) => {
  await setup(page);
  await sendAgentPrompt(page, 'text:retry-exit-history');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('retry-exit-history');
  await app.evaluate(({ dialog }) => {
    (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    let fail = true;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (fail && this.name === 'shelf-agent-history' && args[1] === 'readwrite') {
        fail = false;
        throw new Error('simulated transient exit save failure');
      }
      return original.apply(this, args);
    };
  });
  await quit(app);
  await restored(userDataDir, async next => {
    await expect(next.locator('.agent-msg:visible', { hasText: 'retry-exit-history' }).last()).toBeVisible();
  });
});

test('missing renderer acknowledgement defaults to Cancel and requires explicit Exit anyway', async ({ shelfApp: { app, page } }) => {
  test.setTimeout(60_000);
  await setup(page);
  await app.evaluate(({ ipcMain, dialog }, channel) => {
    ipcMain.removeAllListeners(channel);
    (globalThis as any).__exitTimeoutPrompts = 0;
    (dialog as any).showMessageBox = async (options: { title?: string; buttons?: string[]; defaultId?: number; detail?: string }) => {
      if (options.title !== 'Could not save Agent history') throw new Error('Unexpected dialog');
      if (options.defaultId !== 0 || options.buttons?.[2] !== 'Exit anyway' || !options.detail?.includes('may lose unsaved content')) throw new Error('Missing explicit loss warning');
      (globalThis as any).__exitTimeoutPrompts++;
      return { response: (globalThis as any).__exitTimeoutPrompts === 1 ? 0 : 2, checkboxChecked: false };
    };
  }, IPC.APP_EXIT_RESULT);
  await app.evaluate(({ app }) => app.quit());
  await expect.poll(() => app.evaluate(() => (globalThis as any).__exitTimeoutPrompts), { timeout: 15_000 }).toBe(1);
  await expect(page.locator('.app-exit-overlay')).toHaveCount(0);
  await expect(page.locator('.agent-view:visible')).toBeVisible();
  await quit(app);
});
