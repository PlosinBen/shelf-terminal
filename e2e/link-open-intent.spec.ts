import { expect, test, openAgentTab, sendAgentPrompt } from './helpers';
import { LINK_OPEN } from '../src/shared/link-open-intent';
import fs from 'node:fs';
import path from 'node:path';

// These cases own no home-directory fixture and can run beside other checkouts.
test.use({ homeProjectDirectories: false });

test('anchor capture preserves original relative href and declared source', async ({ shelfApp: { app, page } }) => {
  await app.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, input) => {
      (globalThis as typeof globalThis & { capturedLink?: unknown }).capturedLink = input;
      return { kind: 'opened' };
    });
  }, LINK_OPEN.submit);

  await page.evaluate(() => {
    const owner = document.createElement('div');
    owner.dataset.linkProjectId = 'original-project';
    owner.dataset.linkViewId = 'original-view';
    const link = document.createElement('a');
    link.id = 'relative-file-link';
    link.setAttribute('href', './src/example.ts#L12');
    link.textContent = 'Source file';
    owner.appendChild(link);
    document.body.appendChild(owner);
  });
  await page.locator('#relative-file-link').click();
  await expect.poll(() => app.evaluate(() => (
    (globalThis as typeof globalThis & { capturedLink?: unknown }).capturedLink
  ))).toMatchObject({
    url: './src/example.ts#L12',
    source: { kind: 'project-tab', projectId: 'original-project', tabId: 'original-view' },
  });
});

test('mailto is copy-only and explicit external mailto retains the decision gate', async ({ shelfApp: { app, page } }) => {
  const url = 'mailto:ben@example.com?subject=original%20value';
  await page.evaluate(({ url, attr }) => {
    for (const external of [false, true]) {
      const link = document.createElement('a');
      link.id = external ? 'external-mail' : 'default-mail';
      link.href = url;
      link.textContent = link.id;
      if (external) link.setAttribute(attr, 'external');
      document.body.appendChild(link);
    }
  }, { url, attr: LINK_OPEN.destinationAttribute });
  const rendererUrl = page.url();
  await page.locator('#default-mail').click();
  const preview = page.getByRole('dialog', { name: 'Link preview' });
  await expect(preview).toContainText('Shelf cannot preview email links');
  await expect(preview.locator('.link-preview-original')).toHaveText(url);
  await expect(preview.getByRole('button')).toHaveCount(2);
  await preview.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#external-mail').click();
  const external = page.locator('.external-url-intent-overlay');
  await expect(external).toBeVisible();
  await expect(external.locator('.external-url-intent-url')).toHaveText(url);
  await external.locator('.agent-perm-option', { hasText: 'Cancel' }).click();
  expect(page.url()).toBe(rendererUrl);
});

test('project links preview inert text and open web tabs without external fallback', async ({ shelfApp: { app, page, userDataDir } }) => {
  const cwd = path.join(userDataDir, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'source.html'), '<script>window.previewExecuted=true</script>\nsecond line');
  const project = await page.evaluate(cwd => window.shelfApi.project.add({ name: 'Link Source', cwd, connection: { type: 'local' }, maxTabs: 5 }), cwd);
  const otherCwd = path.join(userDataDir, 'other-project');
  fs.mkdirSync(otherCwd);
  fs.writeFileSync(path.join(otherCwd, 'source.html'), 'WRONG PROJECT');
  await page.evaluate(cwd => window.shelfApi.project.add({ name: 'Other Project', cwd, connection: { type: 'local' }, maxTabs: 5 }), otherCwd);
  await page.reload();
  await expect(page.locator('.sidebar-item', { hasText: 'Link Source' })).toBeVisible();
  await page.locator('.sidebar-item', { hasText: 'Other Project' }).click();
  await page.evaluate(({ id, attrs }) => {
    const owner = document.createElement('div');
    owner.setAttribute(attrs.projectAttribute, id);
    owner.setAttribute(attrs.noteAttribute, 'note-source');
    for (const [name, href] of [['file', './source.html#L2'], ['web', 'https://example.invalid/'], ['bad', 'javascript:alert(1)'], ['missing', './missing']]) {
      const a = document.createElement('a');
      a.id = `project-${name}`; a.href = href; a.textContent = name;
      owner.appendChild(a);
    }
    document.body.appendChild(owner);
  }, { id: project.id, attrs: LINK_OPEN });
  await page.locator('#project-file').click();
  const preview = page.getByRole('dialog', { name: 'Link preview' });
  await expect(preview.locator('.link-preview-content')).toContainText('<script>window.previewExecuted=true</script>');
  await expect(preview.locator('.link-preview-selected')).toContainText('second line');
  expect(await page.evaluate(() => (window as unknown as { previewExecuted?: boolean }).previewExecuted)).toBeUndefined();
  await preview.getByRole('button', { name: 'Close' }).click();
  await page.locator('#project-web').click();
  await expect(page.locator('.web-tab:visible .web-tab-address')).toHaveValue('https://example.invalid/');
  await expect(page.locator('.external-url-intent-overlay')).toHaveCount(0);
  for (const id of ['bad', 'missing']) {
    await page.locator(`#project-${id}`).click();
    await expect(preview).toBeVisible();
    await expect(preview.locator('.link-preview-content')).toHaveCount(0);
    await expect(page.locator('.external-url-intent-overlay')).toHaveCount(0);
    await preview.getByRole('button', { name: 'Close' }).click();
  }
  // Exercise the actual Agent and Notes markup, rather than only a declared
  // source fixture, so a missing owner annotation on either surface fails.
  await openAgentTab(page);
  await sendAgentPrompt(page, 'text:[Agent source](./source.html#L2)');
  await page.locator('.agent-view:visible a', { hasText: 'Agent source' }).click();
  await expect(preview.locator('.link-preview-selected')).toContainText('second line');
  await preview.getByRole('button', { name: 'Close' }).click();
  await page.locator('.right-tab-btn', { hasText: 'Notes' }).click();
  await page.locator('.notes-new-btn').click();
  await page.locator('.notes-textarea').fill('[Note source](./source.html#L2)');
  await page.locator('.notes-mode-btn', { hasText: 'Preview' }).click();
  await page.locator('.notes-preview a', { hasText: 'Note source' }).click();
  await expect(preview.locator('.link-preview-selected')).toContainText('second line');
  await preview.getByRole('button', { name: 'Close' }).click();
  await page.locator('.right-tab-btn', { hasText: 'Notes' }).click();
  const before = await page.locator('.tab-bar .tab').count();
  await sendAgentPrompt(page, 'browser_open:https://example.invalid/approval');
  const browserPrompt = page.locator('.web-perm-overlay');
  await expect(browserPrompt.locator('.browser-open-url')).toHaveText('https://example.invalid/approval');
  await expect(page.locator('.tab-bar .tab')).toHaveCount(before);
  await browserPrompt.locator('.agent-perm-option', { hasText: 'Deny' }).click();
  await expect(browserPrompt).toHaveCount(0);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(before);
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await sendAgentPrompt(page, 'auth_required');
  const auth = page.locator('.agent-auth-pane:visible');
  await auth.locator('.agent-reset-btn', { hasText: 'Log in' }).click();
  const external = page.locator('.external-url-intent-overlay');
  await expect(external).toBeVisible();
  await external.locator('.agent-perm-option', { hasText: 'Cancel' }).click();
  await auth.locator('a.agent-auth-link').click();
  await expect(external).toBeVisible();
  await expect(external.locator('.external-url-intent-url')).toHaveText('https://github.com/login/device?user_code=FAKE-CODE');
  await external.locator('.agent-perm-option', { hasText: 'Cancel' }).click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(before);
});
