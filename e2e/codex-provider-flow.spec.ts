import { test, expect, sendAgentPrompt } from './helpers';
import { CODEX_PROVIDER } from '../src/shared/agent-providers';
import { FAKE_FILE_CHANGES } from '../agent-server/providers/fake/test-env';
import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Renderer/provider-keyed coverage for the temporary official Codex SDK provider.
 *
 * In SHELF_TEST_MODE, every provider is backed by the fake backend. These tests
 * therefore prove the renderer/main routing, registry selectors, project config
 * persistence, auth UI, stop, reload notification, and old/new provider key
 * isolation. The real SDK transport/auth/MCP/runtime behavior is covered by the
 * Codex provider unit/live seam suites.
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const OFFICIAL_LABEL = 'Codex';
const OFFICIAL_MENU_LABEL = `Agent (${OFFICIAL_LABEL})`;

async function setupProject(page: Page) {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-header')).toContainText('Open Project', { timeout: 5_000 });
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
}

async function openAgentTab(page: Page, menuLabel: string) {
  await page.locator('.tab-add').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: menuLabel }).click();
  await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-textarea:visible')).toBeEnabled({ timeout: 5_000 });
}

async function openProjectEdit(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  const panel = page.locator('.project-edit-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });
  return panel;
}

async function readProjects(userDataDir: string): Promise<any[]> {
  const document = JSON.parse(
    await fs.promises.readFile(path.join(userDataDir, 'projects.json'), 'utf-8'),
  );
  return document.projects;
}

async function expectAgentInputReady(page: Page) {
  await expect(page.locator('.agent-textarea:visible')).toBeEnabled({ timeout: 5_000 });
}

async function disconnectAndReconnect(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();
  await expect(page.locator('.connect-prompt')).toBeVisible({ timeout: 5_000 });
  await page.locator('.connect-prompt').click();
  await page.locator('.tab-bar .tab', { hasText: 'Codex' }).click();
  await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });
  await expectAgentInputReady(page);
}

test.describe('Canonical Codex provider renderer flow', () => {
  test('project startup list opens a Codex official tab and runs normal agent controls', async ({ shelfApp: { page, userDataDir } }) => {
    await setupProject(page);

    const panel = await openProjectEdit(page);
    await panel.locator('.default-tab-add', { hasText: 'Add Agent' }).click();
    const agentRow = panel.locator('.default-tab-row', { has: page.locator('.default-tab-kind-agent') });
    const providerSelect = agentRow.locator('.default-tab-provider');
    await expect(providerSelect.locator('option', { hasText: OFFICIAL_LABEL })).toHaveCount(1);
    await providerSelect.selectOption(CODEX_PROVIDER);
    await agentRow.locator('.default-tab-name').fill(OFFICIAL_LABEL);
    await panel.locator('.project-edit-footer .conn-btn-next').click();
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    await expect.poll(async () => (await readProjects(userDataDir))[0]?.defaultTabs
      ?.find((tab: any) => tab.kind === 'agent')?.provider).toBe(CODEX_PROVIDER);

    await disconnectAndReconnect(page);
    await expect(page.locator('.tab-bar .tab', { hasText: 'Codex' })).toHaveCount(1);
    await expect(page.locator('.agent-status-bar:visible')).toContainText('Codex');

    await sendAgentPrompt(page, 'text:official-default');
    await expect(page.locator('.agent-messages:visible')).toContainText('official-default', { timeout: 8_000 });
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });

    await sendAgentPrompt(page, 'auth_required');
    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await pane.locator('.agent-reset-btn', { hasText: 'Log in' }).click();
    await expect(pane.locator('.agent-auth-code')).toHaveText('FAKE-CODE', { timeout: 5_000 });
    const urlPopup = page.locator('.external-url-intent-overlay');
    await expect(urlPopup).toBeVisible({ timeout: 5_000 });
    await urlPopup.locator('.agent-perm-option', { hasText: 'Cancel' }).click();
    await expect(urlPopup).not.toBeVisible();
    await pane.locator('.agent-reset-btn', { hasText: 'Cancel' }).click();
    await expect(pane.locator('.agent-reset-btn', { hasText: 'Log in' })).toBeVisible({ timeout: 5_000 });

    // Cancel leaves the auth pane open by design. Reconnect through the persisted
    // project default to continue exercising the same temporary provider id.
    await disconnectAndReconnect(page);

    await sendAgentPrompt(page, 'delay:5000|text:should-stop');
    await expect(page.locator('.agent-loading')).toBeVisible({ timeout: 5_000 });
    await page.locator('.agent-textarea:visible').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });

    await sendAgentPrompt(page, 'text:before-reload');
    await expect(page.locator('.agent-messages:visible')).toContainText('before-reload', { timeout: 8_000 });
    await page.locator('.right-tab-btn', { hasText: 'Skills' }).click();
    await page.locator('.skills-view .notes-new-btn').click();
    await expect(page.locator('.agent-msg-system', { hasText: 'Skills reloaded' }))
      .toBeVisible({ timeout: 8_000 });
  });

  test('canonical Codex persists only the canonical session key', async ({ shelfApp: { page, userDataDir } }) => {
    await setupProject(page);

    await openAgentTab(page, OFFICIAL_MENU_LABEL);

    await sendAgentPrompt(page, 'text:official-isolated');
    await expect(page.locator('.agent-messages:visible')).toContainText('official-isolated', { timeout: 8_000 });

    await expect.poll(async () => {
      const projects = await readProjects(userDataDir);
      return Object.values(projects[0]?.agentViews ?? {}).map((view: any) => view.provider).sort();
    }).toEqual([CODEX_PROVIDER]);

    const projects = await readProjects(userDataDir);
    expect(Object.keys(projects[0].agentViews)).toHaveLength(1);
  });

  test('Codex web searches render as bodyless fold cards', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    await openAgentTab(page, OFFICIAL_MENU_LABEL);

    await sendAgentPrompt(page, 'websearch:Codex app server protocol');

    const card = page.locator('.agent-msg-fold:has(.fold-label:has-text("Web search")):visible').last();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('.fold-subtitle')).toHaveText('Codex app server protocol');
    await expect(card.locator('.fold-body')).toHaveCount(0);
  });
});

async function setDiffDisplay(page: Page, mode: 'collapsed' | 'expanded') {
  await page.keyboard.press(`${modifier}+,`);
  const settings = page.locator('.settings-panel');
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await settings.locator('.settings-group').filter({ has: page.locator('.settings-label', { hasText: /^Markdown$/ }) }).locator('select').selectOption('expanded');
  await settings.locator('.settings-group').filter({ has: page.locator('.settings-label', { hasText: /^File Diff$/ }) }).locator('select').selectOption(mode);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).not.toBeVisible();
}

function fileCard(page: Page, file: string) {
  return page.locator('.agent-msg-fold:visible').filter({ has: page.locator('.fold-subtitle').filter({ hasText: new RegExp(`^${file.replaceAll('.', '\\.')}$`) }) }).last();
}

test.describe('Codex file changes use File Diff display settings', () => {
  // A multi-file edit must remain collapsible by file even when a file has
  // several hunks; check the real wire projection and persisted body too.
  test('collapses each file, keeps hunk boundaries and restores all hunks from history', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    // Reconnect restores configured startup Views, not manually added tabs.
    const panel = await openProjectEdit(page);
    await panel.locator('.default-tab-add', { hasText: 'Add Agent' }).click();
    const agentRow = panel.locator('.default-tab-row', { has: page.locator('.default-tab-kind-agent') });
    await agentRow.locator('.default-tab-provider').selectOption(CODEX_PROVIDER);
    await agentRow.locator('.default-tab-name').fill(OFFICIAL_LABEL);
    await panel.locator('.project-edit-footer .conn-btn-next').click();
    await expect(panel).not.toBeVisible();
    await disconnectAndReconnect(page);
    await setDiffDisplay(page, 'collapsed');
    await sendAgentPrompt(page, FAKE_FILE_CHANGES.SUCCESS);
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
    const cards = page.locator('.agent-msg-fold:visible').filter({ has: page.locator('.fold-label', { hasText: /^Edit file$/ }) });
    await expect(cards).toHaveCount(2);
    await expect(cards.locator('.fold-body')).toHaveCount(0);
    await expect(page.locator('.fold-body-markdown:visible')).toHaveText('Ordinary Markdown stays expanded');

    const a = fileCard(page, 'a.ts');
    const b = fileCard(page, 'b.ts');
    await a.locator('.fold-header').click();
    await expect(a.locator('.agent-diff-hunk')).toHaveCount(2);
    await expect(a.locator('.agent-diff-hunk-range')).toHaveText(['@@ -2,3 +2,3 @@', '@@ -16,2 +16,3 @@']);
    await expect(a.locator('.agent-diff-hunk').nth(1).locator('.agent-diff-sbs-panel-left .agent-diff-sbs-ln')).toHaveText(['16', '', '17']);
    await expect(a.locator('.agent-diff-hunk').nth(1).locator('.agent-diff-sbs-panel-right .agent-diff-sbs-ln')).toHaveText(['16', '17', '18']);
    await expect(a).toContainText('inserted');
    await expect(b.locator('.fold-body')).toHaveCount(0);
    await a.locator('.fold-header').click();
    await expect(a.locator('.agent-diff-hunk')).toHaveCount(0);

    await sendAgentPrompt(page, FAKE_FILE_CHANGES.LEGACY);
    await expect(fileCard(page, 'legacy.ts')).toBeVisible();
    await disconnectAndReconnect(page);
    await expect(cards).toHaveCount(2);
    await expect(cards.locator('.fold-body')).toHaveCount(0);
    await setDiffDisplay(page, 'expanded');
    await expect(a.locator('.agent-diff-hunk')).toHaveCount(2);
    await expect(b.locator('.agent-diff-hunk')).toHaveCount(1);
    await expect(a).toContainText('inserted');
    await expect(a.locator('.agent-diff-hunk-range')).toHaveText(['@@ -2,3 +2,3 @@', '@@ -16,2 +16,3 @@']);
    await expect(fileCard(page, 'legacy.ts')).toContainText('legacy after');
    await expect(fileCard(page, 'legacy.ts').locator('.agent-diff-hunk')).toHaveCount(0);
  });

  test('shows operation labels, relative paths, raw content and settled summaries through history', async ({ shelfApp: { page } }) => {
    await setupProject(page);
    const panel = await openProjectEdit(page);
    await panel.locator('.default-tab-add', { hasText: 'Add Agent' }).click();
    const agentRow = panel.locator('.default-tab-row', { has: page.locator('.default-tab-kind-agent') });
    await agentRow.locator('.default-tab-provider').selectOption(CODEX_PROVIDER);
    await agentRow.locator('.default-tab-name').fill(OFFICIAL_LABEL);
    await panel.locator('.project-edit-footer .conn-btn-next').click();
    await expect(panel).not.toBeVisible();
    await disconnectAndReconnect(page);
    await setDiffDisplay(page, 'collapsed');
    await sendAgentPrompt(page, FAKE_FILE_CHANGES.MIXED);
    const cards = page.locator('.agent-msg-fold:visible').filter({ has: page.locator('.fold-label', { hasText: /^(Create|Edit|Delete|Move) file$/ }) });
    await expect(cards).toHaveCount(7);
    await expect(fileCard(page, 'a.ts').locator('.fold-body')).toHaveCount(0);
    await expect(fileCard(page, 'added.md').locator('.fold-label')).toHaveText('Create file');
    await expect(fileCard(page, 'added.md').locator('pre')).toHaveCount(0);
    await fileCard(page, 'added.md').locator('.fold-header').click();
    await expect(fileCard(page, 'added.md').locator('pre')).toHaveText('```\noriginal added content\n```\n');
    await expect(fileCard(page, 'deleted.ts').locator('.fold-label')).toHaveText('Delete file');
    await fileCard(page, 'deleted.ts').locator('.fold-header').click();
    await expect(fileCard(page, 'deleted.ts')).toContainText('deleted content');
    for (const file of ['moved.ts → destination.ts', 'empty.ts']) {
      await expect(fileCard(page, file).locator('.agent-chevron')).toHaveCount(0);
      await fileCard(page, file).locator('.fold-header').click();
      await expect(fileCard(page, file).locator('.fold-body')).toHaveCount(0);
    }
    await expect(fileCard(page, 'invalid.ts')).toContainText('malformed');
    await expect(fileCard(page, 'invalid.ts')).toContainText('preserved');
    await disconnectAndReconnect(page);
    await expect(cards).toHaveCount(7);
    for (const file of ['moved.ts → destination.ts', 'empty.ts']) {
      await expect(fileCard(page, file).locator('.agent-chevron')).toHaveCount(0);
      await expect(fileCard(page, file).locator('.fold-error-banner')).toHaveCount(0);
    }
    for (const [scenario, status] of [[FAKE_FILE_CHANGES.FAILED, 'failed'], [FAKE_FILE_CHANGES.DECLINED, 'declined']]) {
      await sendAgentPrompt(page, scenario);
      await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
      for (const path of ['a.ts', 'b.ts']) {
        await expect(fileCard(page, path).locator('.fold-error-banner')).toHaveText(`File change ${status}`);
        await expect(fileCard(page, path).locator('.fold-body-diff')).toHaveCount(0);
      }
    }
    await expect(cards).toHaveCount(11);
  });
});
