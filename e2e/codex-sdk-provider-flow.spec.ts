import { test, expect, sendAgentPrompt } from './helpers';
import { CODEX_PROVIDER } from '../src/shared/agent-providers';
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
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await prompt.click();
  }
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
  return JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'projects.json'), 'utf-8'));
}

async function expectAgentInputReady(page: Page) {
  await expect(page.locator('.agent-textarea:visible')).toBeEnabled({ timeout: 5_000 });
}

async function disconnectAndReconnect(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Disconnect' }).click();
  await expect(page.locator('.connect-prompt')).toBeVisible({ timeout: 5_000 });
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.agent-view:visible')).toBeVisible({ timeout: 5_000 });
  await expectAgentInputReady(page);
}

test.describe('Canonical Codex provider renderer flow', () => {
  test('project default opens a Codex official tab and runs normal agent controls', async ({ shelfApp: { page, userDataDir } }) => {
    await setupProject(page);

    const panel = await openProjectEdit(page);
    const agentField = panel.locator('.project-edit-field').filter({ hasText: 'Default provider for new agent tabs' });
    const providerSelect = agentField.locator('select');
    await expect(providerSelect.locator('option', { hasText: OFFICIAL_LABEL })).toHaveCount(1);
    await providerSelect.selectOption(CODEX_PROVIDER);
    await agentField.locator('input[type="checkbox"]').check();
    await panel.locator('.project-edit-footer .conn-btn-next').click();
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    await expect.poll(async () => (await readProjects(userDataDir))[0]?.defaultAgentProvider)
      .toBe(CODEX_PROVIDER);

    await disconnectAndReconnect(page);
    await expect(page.locator('.tab-bar .tab').first()).toContainText('Codex');
    await expect(page.locator('.agent-status-bar:visible')).toContainText('Codex');

    await sendAgentPrompt(page, 'text:official-default');
    await expect(page.locator('.agent-messages:visible')).toContainText('official-default', { timeout: 8_000 });
    await expect(page.locator('.agent-status-label:visible')).toHaveText('idle', { timeout: 5_000 });

    await sendAgentPrompt(page, 'auth_required');
    const pane = page.locator('.agent-auth-pane:visible');
    await expect(pane).toBeVisible({ timeout: 5_000 });
    await pane.locator('.agent-reset-btn', { hasText: 'Log in' }).click();
    await expect(pane.locator('.agent-auth-code')).toHaveText('FAKE-CODE', { timeout: 5_000 });
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
      return Object.keys(projects[0]?.agentSessionIds ?? {}).sort();
    }).toEqual([CODEX_PROVIDER]);

    const projects = await readProjects(userDataDir);
    const ids = projects[0].agentSessionIds;
    expect(ids[CODEX_PROVIDER]).toBeTruthy();
  });
});
