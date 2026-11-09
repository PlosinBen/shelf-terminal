import { test, expect, openAgentTab, sendAgentPrompt } from './helpers';
import { _electron as electron, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { IPC } from '../src/shared/ipc-channels';
import { FAKE_TEST_ENV } from '../agent-server/providers/fake/test-env';
import { PROJECT_MUTATION } from '../src/shared/project-mutations';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
test.use({ nativePermissions: true });
test.afterEach(async ({ shelfApp: { userDataDir } }, info) => {
  const root = path.join(userDataDir, 'logs');
  if (info.status !== info.expectedStatus && fs.existsSync(root)) {
    const logs = fs.readdirSync(root, { recursive: true }).filter(name => String(name).endsWith('.log'));
    for (const name of logs) await info.attach('main-log', { body: fs.readFileSync(path.join(root, String(name))), contentType: 'text/plain' });
  }
});
async function setup(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
}
async function save(page: Page, index: number) {
  await page.locator('.tab-bar .tab').nth(index).click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Save to Default', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs.length).toBe(index + 1);
}
async function reconnect(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect', exact: true }).click();
  await expect(page.locator('.connect-prompt')).toBeVisible();
  await page.locator('.connect-prompt').click();
}
async function configureA(page: Page) {
  await page.locator('.agent-status-seg.agent-status-interactive:visible', { hasText: 'fake-model' }).click();
  await page.locator('.agent-perm-option:visible', { hasText: 'fake-model-pro' }).click();
  await expect(page.locator('.agent-status-seg:visible', { hasText: 'fake-model-pro' })).toBeVisible();
}

async function historyRows(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shelf-agent-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<any[]>((resolve, reject) => {
        const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

test('closing or disconnecting temporary Views collects only their history and metadata', async ({ shelfApp: { app, page } }) => {
  await setup(page);
  await openAgentTab(page); await sendAgentPrompt(page, 'text:keep-default'); await save(page, 1);
  const saved = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  await app.evaluate(({ ipcMain }, { channel, createKind }) => {
    const original = (ipcMain as any)._invokeHandlers.get(channel);
    if (!original) throw new Error('Missing Project update handler');
    let delayNext = true;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, projectId, mutation) => {
      if (delayNext && mutation.kind === createKind) {
        delayNext = false;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return original(event, projectId, mutation);
    });
  }, { channel: IPC.PROJECT_UPDATE, createKind: PROJECT_MUTATION.CREATE_AGENT_VIEW });
  await openAgentTab(page);
  // The helper must return on the new View even while its real allocation is
  // delayed. Waiting here would hide a helper that returned the old input.
  expect(await page.locator('.tab-bar .tab').count()).toBe(3);
  await sendAgentPrompt(page, 'text:discard-temporary');
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
  await expect.poll(async () => Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews)).toEqual(Object.keys(saved.agentViews));
  expect((await historyRows(page)).some(row => row.content === 'discard-temporary')).toBe(false);
  await reconnect(page);
  await page.locator('.tab-bar .tab').nth(1).click();
  await expect(page.locator('.agent-msg:visible', { hasText: 'keep-default' }).last()).toBeVisible();
  await openAgentTab(page); await sendAgentPrompt(page, 'text:disconnect-temporary');
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await reconnect(page);
  await expect.poll(async () => Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews)).toEqual(Object.keys(saved.agentViews));
  expect((await historyRows(page)).some(row => row.content === 'disconnect-temporary')).toBe(false);
  await page.locator('.tab-bar .tab').nth(1).click();
  await expect(page.locator('.agent-msg:visible', { hasText: 'keep-default' }).last()).toBeVisible();
});

test('removing a Default collects a closed View but preserves a live View until close', async ({ shelfApp: { page } }) => {
  await setup(page);
  const removeDefault = async () => {
    await page.locator('.sidebar-item').first().click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Edit', exact: true }).click();
    const panel = page.locator('.project-edit-panel');
    await panel.locator('.default-tab-row').nth(1).locator('.default-tab-remove').click();
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel).not.toBeVisible();
  };
  await openAgentTab(page); await sendAgentPrompt(page, 'text:closed-default'); await save(page, 1);
  await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
  await removeDefault();
  await expect.poll(async () => Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews).length).toBe(0);
  expect((await historyRows(page)).some(row => row.content === 'closed-default')).toBe(false);
  await openAgentTab(page); await sendAgentPrompt(page, 'text:live-default'); await save(page, 1);
  await removeDefault();
  expect(Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews)).toHaveLength(1);
  await expect(page.locator('.agent-msg:visible', { hasText: 'live-default' }).last()).toBeVisible();
  await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
  await expect.poll(async () => Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews).length).toBe(0);
});

test('failed history clear retains ownership and retries on renderer startup', async ({ shelfApp: { app, page } }) => {
  await setup(page); await openAgentTab(page); await sendAgentPrompt(page, 'text:retry-clear');
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__historyCleanupPrompts = 0;
    (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
      if (options.title === 'Project update failed') (globalThis as any).__historyCleanupPrompts++;
      return { response: 1, checkboxChecked: false };
    };
  });
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    (window as any).__restoreHistoryDelete = () => { IDBObjectStore.prototype.delete = original; };
    IDBObjectStore.prototype.delete = function (key) {
      if (this.name === 'messages') throw new Error('simulated history clear failure');
      return original.call(this, key);
    };
  });
  await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__historyCleanupPrompts)).toBe(1);
  expect(Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews)).toHaveLength(1);
  expect((await historyRows(page)).some(row => row.content === 'retry-clear')).toBe(true);
  await page.evaluate(() => (window as any).__restoreHistoryDelete());
  await page.reload();
  await expect.poll(async () => Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews).length).toBe(0);
  expect((await historyRows(page)).some(row => row.content === 'retry-clear')).toBe(false);
});

test('deleted Project cleanup survives cancellation and does not sweep unknown history', async ({ shelfApp: { app, page } }) => {
  await setup(page); await openAgentTab(page); await sendAgentPrompt(page, 'text:deleted-retry');
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__deleteHistoryPrompts = 0;
    (dialog as any).showMessageBox = async (_window: unknown, options: { title?: string }) => {
      if (options.title === 'Project update failed') (globalThis as any).__deleteHistoryPrompts++;
      return { response: 1, checkboxChecked: false };
    };
  });
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shelf-agent-history');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').add({ sessionId: 'unknown-owner', id: 'old-history', type: 'user', content: 'unknown-history', timestamp: 1 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key) {
      if (this.name === 'messages') throw new Error('simulated deleted Project history failure');
      return original.call(this, key);
    };
  });
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Remove', exact: true }).click();
  await page.locator('.conn-btn-danger', { hasText: 'Remove', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__deleteHistoryPrompts)).toBe(1);
  expect(await page.evaluate(() => window.shelfApi.project.getAll())).toEqual([]);
  expect((await historyRows(page)).some(row => row.content === 'deleted-retry')).toBe(true);
  // Reload drops the injected failure but retains the real IndexedDB journal.
  await page.reload();
  await expect.poll(async () => (await historyRows(page)).some(row => row.content === 'deleted-retry')).toBe(false);
  expect((await historyRows(page)).some(row => row.content === 'unknown-history')).toBe(true);
});

test('same-provider Views keep separate history/settings and Default references across reconnect', async ({ shelfApp: { page } }) => {
  await setup(page);
  await openAgentTab(page);
  await sendAgentPrompt(page, 'text:alpha-only');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('alpha-only');
  await configureA(page);
  await save(page, 1);
  await openAgentTab(page);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(3);
  await expect(page.locator('.agent-status-seg:visible', { hasText: 'fake-model-pro' })).toHaveCount(0);
  await sendAgentPrompt(page, 'text:beta-only');
  await expect(page.locator('.agent-msg:visible').last()).toContainText('beta-only');
  await expect(page.locator('.agent-msg:visible', { hasText: 'alpha-only' })).toHaveCount(0);
  await save(page, 2);
  await page.locator('.tab-bar .tab').nth(2).click({ button: 'right' });
  await expect(page.locator('.context-menu-item', { hasText: 'Already saved' })).toBeDisabled();
  await page.locator('.sidebar-item').first().click();
  const before = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  const defaults = before.defaultTabs.filter(t => t.kind === 'agent');
  expect(defaults[0].sessionId).not.toBe(defaults[1].sessionId);
  expect(await page.evaluate(({ project, sessionId }) => window.shelfApi.agent.init(
    'duplicate-mount', project.cwd, project.connection, 'claude', sessionId, { projectId: project.id },
  ), { project: before, sessionId: defaults[0].sessionId })).toBe(false);
  await page.locator('.tab-bar .tab').nth(2).locator('.tab-close').click();
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs).toEqual(before.defaultTabs);
  await reconnect(page);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(3);
  await page.locator('.tab-bar .tab').nth(1).click();
  await expect(page.locator('.agent-msg:visible', { hasText: 'alpha-only' }).last()).toBeVisible();
  await expect(page.locator('.agent-msg:visible', { hasText: 'beta-only' })).toHaveCount(0);
  await expect(page.locator('.agent-status-seg:visible', { hasText: 'fake-model-pro' })).toBeVisible();
  await page.locator('.tab-bar .tab').nth(2).click();
  await expect(page.locator('.agent-msg:visible', { hasText: 'beta-only' }).last()).toBeVisible();
  await sendAgentPrompt(page, '/clear');
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await page.locator('.agent-view:visible').getByRole('button', { name: 'Clear History', exact: true }).click();
  await reconnect(page);
  await page.locator('.tab-bar .tab').nth(1).click();
  await expect(page.locator('.agent-msg:visible', { hasText: 'alpha-only' }).last()).toBeVisible();
  const after = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  expect(after.defaultTabs).toEqual(before.defaultTabs);
  expect(Object.keys(after.agentViews)).toEqual(Object.keys(before.agentViews));
});

test('Project editor preserves View bindings and background preferences', async ({ shelfApp: { app, page } }) => {
  await setup(page);
  await app.evaluate(({ ipcMain }, channel) => {
    const original = (ipcMain as any)._invokeHandlers.get(channel);
    if (!original) throw new Error('Missing real Agent init handler');
    (globalThis as any).__multiViewBindings = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, payload) => {
      (globalThis as any).__multiViewBindings.push({ tabId: payload.tabId, sessionId: payload.sessionId });
      return original(event, payload);
    });
  }, IPC.AGENT_INIT);
  await openAgentTab(page); await save(page, 1);
  await openAgentTab(page); await save(page, 2);
  const before = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  const sessionId = before.defaultTabs.filter(t => t.kind === 'agent')[0].sessionId!;
  const tabId = await app.evaluate((_, sessionId) => (globalThis as any).__multiViewBindings.find((entry: any) => entry.sessionId === sessionId)?.tabId as string, sessionId);
  expect(tabId).toBeTruthy();
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit', exact: true }).click();
  const panel = page.locator('.project-edit-panel');
  await panel.locator('.settings-input').first().fill('edited multi');
  // The modal intentionally blocks picker interaction. Drive a real backend
  // config edit on A while the editor stays open, allowing its normal report
  // to persist the confirmed value instead of spoofing canonical preferences.
  await page.evaluate(tabId => window.shelfApi.agent.send(tabId, { configEdit: { key: 'effort', value: 'high' } }), tabId);
  await expect.poll(async () => (await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews[sessionId].prefs.effort).toBe('high');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  const after = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  expect(after.defaultTabs).toEqual(before.defaultTabs);
  expect(after.agentViews[sessionId].prefs.effort).toBe('high');
});

test('saved same-provider Views restore after app restart', async ({ shelfApp: { app, page, userDataDir } }) => {
  await setup(page);
  await openAgentTab(page); await sendAgentPrompt(page, 'text:restart-alpha'); await save(page, 1);
  await openAgentTab(page); await sendAgentPrompt(page, 'text:restart-beta'); await save(page, 2);
  await expect(page.locator('.agent-msg:visible').last()).toContainText('restart-beta');
  const before = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  // Restore is independent of the existing five-second history-save throttle.
  // Establish durable input before exiting; quit/flush policy is a separate scope.
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shelf-agent-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.filter(row => row.type === 'reply' && ['restart-alpha', 'restart-beta'].includes(row.content)).length;
  }), { timeout: 10_000 }).toBe(2);
  await openAgentTab(page); await sendAgentPrompt(page, 'text:restart-temporary');
  await expect.poll(async () => (await historyRows(page)).filter(row => row.content === 'restart-temporary').length, { timeout: 10_000 }).toBeGreaterThan(0);
  await app.close();
  const restarted = await electron.launch({ args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`], env: { ...process.env, NODE_ENV: 'test', SHELF_TEST_MODE: '1', [FAKE_TEST_ENV.NATIVE_PERMISSIONS]: '1' } });
  try {
    const next = await restarted.firstWindow();
    await next.waitForSelector('.app');
    await expect.poll(async () => Object.keys((await next.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews)).toEqual(Object.keys(before.agentViews));
    expect((await historyRows(next)).some(row => row.content === 'restart-temporary')).toBe(false);
    await next.locator('.sidebar-item').first().click();
    await next.locator('.connect-prompt').click();
    await expect(next.locator('.tab-bar .tab')).toHaveCount(3);
    await next.locator('.tab-bar .tab').nth(1).click();
    await expect(next.locator('.agent-msg:visible', { hasText: 'restart-alpha' }).last()).toBeVisible();
    await next.locator('.tab-bar .tab').nth(2).click();
    await expect(next.locator('.agent-msg:visible', { hasText: 'restart-beta' }).last()).toBeVisible();
    expect((await next.evaluate(() => window.shelfApi.project.getAll()))[0].defaultTabs).toEqual(before.defaultTabs);
  } finally { await restarted.close(); }
});

test('Project editor creates separate same-provider defaults and cancel allocates nothing', async ({ shelfApp: { page } }) => {
  await setup(page);
  const openEditor = async () => {
    await page.locator('.sidebar-item').first().click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Edit', exact: true }).click();
    return page.locator('.project-edit-panel');
  };
  let panel = await openEditor();
  await panel.getByRole('button', { name: '+ Add Agent', exact: true }).click();
  await panel.locator('.settings-close').click();
  expect(Object.keys((await page.evaluate(() => window.shelfApi.project.getAll()))[0].agentViews)).toEqual([]);
  panel = await openEditor();
  for (const name of ['Implementer', 'Reviewer']) {
    await panel.getByRole('button', { name: '+ Add Agent', exact: true }).click();
    const row = panel.locator('.default-tab-row').last();
    await row.locator('.default-tab-provider').selectOption('claude');
    await row.locator('.default-tab-name').fill(name);
  }
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  const saved = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  const agents = saved.defaultTabs.filter(t => t.kind === 'agent');
  expect(agents.map(t => t.name)).toEqual(['Implementer', 'Reviewer']);
  expect(agents[0].sessionId).not.toBe(agents[1].sessionId);
  expect(Object.values(saved.agentViews).every(v => v.provider === 'claude' && Object.keys(v.prefs).length === 0)).toBe(true);
  await reconnect(page);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(3);
});

test('Project deletion clears history of a closed Default View and a live temporary View', async ({ shelfApp: { page } }) => {
  await setup(page);
  for (const text of ['delete-alpha', 'delete-beta']) {
    await openAgentTab(page);
    await sendAgentPrompt(page, `text:${text}`);
    await expect(page.locator('.agent-msg:visible').last()).toContainText(text);
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
    if (text === 'delete-alpha') {
      await save(page, 1);
      await page.locator('.tab-bar .tab').last().locator('.tab-close').click();
    }
  }
  const countRows = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shelf-agent-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.filter(row => row.type === 'reply' && ['delete-alpha', 'delete-beta'].includes(row.content)).length;
  });
  await expect.poll(countRows).toBeGreaterThanOrEqual(1);
  const project = (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
  expect(project.defaultTabs).toHaveLength(2);
  expect(Object.keys(project.agentViews)).toHaveLength(2);
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Remove', exact: true }).click();
  await page.locator('.conn-btn-danger', { hasText: 'Remove', exact: true }).click();
  await expect(page.locator('.sidebar-item')).toHaveCount(0);
  await expect.poll(countRows).toBe(0);
});
