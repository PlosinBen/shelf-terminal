import { test, expect } from './helpers';
import type { Page } from '@playwright/test';
import { IPC } from '../src/shared/ipc-channels';
import { PROJECT_MUTATION } from '../src/shared/project-mutations';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
async function setup(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/');
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible();
  await expect(page.locator('.sidebar-item')).toHaveCount(1);
  return (await page.evaluate(() => window.shelfApi.project.getAll()))[0];
}
async function edit(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit', exact: true }).click();
  const panel = page.locator('.project-edit-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('background unread updates preserve the Project editing draft', async ({ shelfApp: { app, page } }) => {
  await setup(page);
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await page.keyboard.press(`${modifier}+t`);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
  await page.waitForTimeout(500);
  await page.locator('.tab-bar .tab').first().click();
  await page.locator('.tab-bar .tab').nth(1).click();
  const tabId = await page.evaluate(() => [...(window as any).__shelfTerminalCache__.keys()][0] as string);
  const panel = await edit(page);
  await panel.locator('.settings-input').first().fill('keep my draft');
  await app.evaluate(({ BrowserWindow }, { channel, tabId }) => {
    BrowserWindow.getAllWindows()[0].webContents.send(channel, { tabId, data: 'background output\r\n' });
  }, { channel: IPC.PTY_DATA, tabId });
  await expect(page.locator('.tab-bar .tab').first().locator('.tab-badge')).toBeVisible();
  await expect(panel.locator('.settings-input').first()).toHaveValue('keep my draft');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0].name).toBe('keep my draft');
});

test('saving one editor field preserves background preferences and untouched fields', async ({ shelfApp: { page } }) => {
  const project = await setup(page);
  const created = await page.evaluate(({ id, kind }) => window.shelfApi.project.update(id, { kind, provider: 'claude' }), { id: project.id, kind: PROJECT_MUTATION.CREATE_AGENT_VIEW });
  if (!created.ok || !created.sessionId) throw new Error('Missing test Agent View');
  const panel = await edit(page);
  await panel.locator('.settings-input').first().fill('edited name');
  await page.evaluate(async ({ id, edit, report, sessionId }) => {
    await window.shelfApi.project.update(id, { kind: report, sessionId, report: { currentModel: 'background-model' } });
    await window.shelfApi.project.update(id, { kind: edit, edits: [{ field: 'initScript', before: null, value: 'background init' }] });
  }, { id: project.id, edit: PROJECT_MUTATION.EDIT, report: PROJECT_MUTATION.AGENT_REPORT, sessionId: created.sessionId });
  await expect(panel.locator('.settings-input').first()).toHaveValue('edited name');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0]).toMatchObject({
    name: 'edited name', initScript: 'background init', agentViews: { [created.sessionId]: { provider: 'claude', prefs: { model: 'background-model' } } },
  });
});

test('a cancelled pre-commit failure keeps the draft and permits retry', async ({ shelfApp: { app, page } }) => {
  const project = await setup(page);
  const panel = await edit(page);
  await panel.locator('.settings-input').first().fill('retry my draft');
  await app.evaluate(({ ipcMain, dialog }, channel) => {
    const update = (ipcMain as any)._invokeHandlers.get(channel);
    if (!update) throw new Error('Missing real update handler');
    let fail = true;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      if (fail) {
        fail = false;
        await new Promise<void>(resolve => { (globalThis as any).__releaseEditFailure = resolve; });
        throw new Error('simulated pre-commit failure');
      }
      return update(...args);
    });
    (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, IPC.PROJECT_UPDATE);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(panel.locator('.settings-input').first()).toBeDisabled();
  await expect(panel.locator('.settings-close')).toBeDisabled();
  await expect(panel.locator('fieldset')).toHaveAttribute('inert', '');
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releaseEditFailure)).toBe('function');
  await app.evaluate(() => (globalThis as any).__releaseEditFailure());
  await expect(panel.getByRole('alert')).toContainText('draft was kept');
  await expect(panel.locator('.settings-input').first()).toHaveValue('retry my draft');
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0].name).toBe(project.name);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0].name).toBe('retry my draft');
});

test('post-commit refresh retry does not resend the mutation', async ({ shelfApp: { app, page } }) => {
  await setup(page);
  const panel = await edit(page);
  await panel.locator('.settings-input').first().fill('saved once');
  await app.evaluate(({ ipcMain, dialog }, channels) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => any>;
    const update = handlers.get(channels.update)!;
    const getAll = handlers.get(channels.getAll)!;
    if (!update || !getAll) throw new Error('Missing real IPC handlers');
    let failRefresh = false;
    (globalThis as any).__editMutationCount = 0;
    ipcMain.removeHandler(channels.update);
    ipcMain.handle(channels.update, async (...args) => {
      (globalThis as any).__editMutationCount++;
      const result = await update(...args);
      failRefresh = true;
      return result;
    });
    ipcMain.removeHandler(channels.getAll);
    ipcMain.handle(channels.getAll, (...args) => {
      if (failRefresh) { failRefresh = false; throw new Error('research refresh failure'); }
      return getAll(...args);
    });
    (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { update: IPC.PROJECT_UPDATE, getAll: IPC.PROJECT_GET_ALL });
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  expect(await app.evaluate(() => (globalThis as any).__editMutationCount)).toBe(1);
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0].name).toBe('saved once');
});

test('same-field conflict keeps the draft and rejects the whole edit', async ({ shelfApp: { page } }, testInfo) => {
  const project = await setup(page);
  const panel = await edit(page);
  await panel.locator('.settings-input').first().fill('my draft');
  await panel.locator('.project-edit-textarea').first().fill('must not partially save');
  expect(await page.evaluate(({ id, kind, before }) => window.shelfApi.project.update(id, {
    kind, edits: [{ field: 'name', before, value: 'external name' }],
  }), { id: project.id, kind: PROJECT_MUTATION.EDIT, before: project.name })).toEqual({ ok: true });
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('changed');
  await expect(panel.getByRole('alert')).toBeVisible();
  const fieldGap = await panel.locator('fieldset').evaluate(node =>
    node.children[1].getBoundingClientRect().top - node.children[0].getBoundingClientRect().bottom);
  expect(fieldGap).toBeGreaterThanOrEqual(13);
  const alertBox = await panel.getByRole('alert').boundingBox();
  const footerBox = await panel.locator('.project-edit-footer').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(footerBox!.y + 1);
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
  await panel.screenshot({ path: testInfo.outputPath('conflict.png') });
  await expect(panel.locator('.settings-input').first()).toHaveValue('my draft');
  expect((await page.evaluate(() => window.shelfApi.project.getAll()))[0]).toMatchObject({ name: 'external name', initScript: null });
  await panel.getByRole('button', { name: 'Reset Changes', exact: true }).click();
  await expect(panel.locator('.settings-input').first()).toHaveValue('external name');
  await panel.locator('.settings-input').first().fill('reviewed name');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
});
