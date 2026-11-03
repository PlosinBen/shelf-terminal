import { test, expect, readActiveTerminalText, openAgentTab, sendAgentPrompt } from './helpers';
import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Project plain env vars — set in Project Edit → injected into EVERY process
 * Shelf launches for the project. Two surfaces, both driven end-to-end on the
 * local connector (the injection helper is identical across connectors; the
 * docker/ssh/wsl branches are covered by unit tests on the spawn-arg builders):
 *
 *  1. terminals — a NEW terminal (spawned after the var is set) sees it via `echo`
 *  2. agent-server — the fake provider's `env:` scenario echoes the exec proc's env
 *
 * Regression guard for the plain-env injection wiring (resolveProjectEnv →
 * createShell / agent-server spawn).
 */

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const VAR = 'PROJ_E2E_VAR';
const VALUE = 'e2e-injected';

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
  await page.waitForTimeout(500);
}

/** Open Project Edit, add a plain env var (VAR=VALUE), and save. */
async function addProjectEnvVar(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  const panel = page.locator('.project-edit-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  await panel.locator('.default-tab-add', { hasText: 'Add Variable' }).click();
  const row = panel.locator('.env-var-row').last();
  await row.locator('.env-var-key').fill(VAR);
  await row.locator('.env-var-value').fill(VALUE);
  // No validation error on a good, unique, non-reserved key.
  await expect(panel.locator('.env-var-error')).toHaveCount(0);

  await panel.locator('.project-edit-footer .conn-btn-next').click();
  await expect(panel).not.toBeVisible({ timeout: 3_000 });
}

test('plain env var reaches a newly-spawned terminal', async ({ shelfApp: { page, userDataDir } }) => {
  await setupProject(page);
  await addProjectEnvVar(page);

  // A NEW terminal spawns AFTER the var is saved → it inherits the injected env.
  await page.keyboard.press(`${modifier}+t`);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
  const terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1000); // let the shell reach its prompt

  await terminal.click();
  await page.keyboard.type(`echo "seen=$${VAR}"`);
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => readActiveTerminalText(page), { timeout: 8_000 })
    .toContain(`seen=${VALUE}`);
  for (const name of ['project-secrets.json', 'secret-key.local', 'secret-key.enc']) {
    expect(fs.existsSync(path.join(userDataDir, name))).toBe(false);
  }
});

test('plain env var reaches the agent-server (exec process env)', async ({ shelfApp: { page } }) => {
  await setupProject(page);
  await addProjectEnvVar(page);

  // Agent session starts after the var is saved → the exec proc inherits it.
  await openAgentTab(page);
  await sendAgentPrompt(page, `env:${VAR}`);

  await expect(page.locator('.agent-messages:visible'))
    .toContainText(`env ${VAR}=${VALUE}`, { timeout: 8_000 });
});

test('Project Edit has only plain env and leaves legacy secret files untouched', async ({ shelfApp: { page, userDataDir } }) => {
  // Malformed legacy content must not be parsed, migrated, or deleted.
  const legacyFiles = new Map([
    ['project-secrets.json', 'retired side-car: do not parse or modify'],
    ['secret-key.local', 'retired local key'],
    ['secret-key.enc', 'retired OS-wrapped key'],
  ]);
  for (const [name, content] of legacyFiles) fs.writeFileSync(path.join(userDataDir, name), content);
  await setupProject(page);
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit', exact: true }).click();
  const panel = page.locator('.project-edit-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Secret Variables', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '+ Add Secret', exact: true })).toHaveCount(0);
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  expect(await page.evaluate(() => ['listSecretKeys', 'setSecret', 'deleteSecret', 'copySecrets', 'secretKeyTier']
    .filter(key => key in window.shelfApi.project))).toEqual([]);
  await panel.locator('.settings-close').click();
  await addProjectEnvVar(page);
  await openAgentTab(page);
  await sendAgentPrompt(page, 'env:' + VAR);
  await expect(page.locator('.agent-messages:visible')).toContainText('env ' + VAR + '=' + VALUE);
  const project = await page.evaluate(async () => (await window.shelfApi.project.getAll())[0]);
  expect(project.envPlain).toEqual({ [VAR]: VALUE });
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Remove', exact: true }).click();
  await page.locator('.conn-btn-danger', { hasText: 'Remove', exact: true }).click();
  await expect(page.locator('.sidebar-item')).toHaveCount(0);
  for (const [name, content] of legacyFiles) expect(fs.readFileSync(path.join(userDataDir, name), 'utf8')).toBe(content);
});
