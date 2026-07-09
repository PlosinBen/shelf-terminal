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
const SVAR = 'SECRET_E2E_VAR';
const SVALUE = 'secret-injected-xyz';

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

test('plain env var reaches a newly-spawned terminal', async ({ shelfApp: { page } }) => {
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

/** Open Project Edit, add a SECRET env var (write-only), and save. */
async function addProjectSecretVar(page: Page) {
  await page.locator('.sidebar-item').first().click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Edit' }).click();
  const panel = page.locator('.project-edit-panel');
  await expect(panel).toBeVisible({ timeout: 3_000 });

  await panel.locator('.default-tab-add', { hasText: 'Add Secret' }).click();
  // The secret value field is a password input — the clean discriminator from
  // the plain (text) value fields above it.
  const secretRow = panel.locator('.env-var-row', { has: page.locator('input.env-var-value[type="password"]') });
  await secretRow.locator('.env-var-key').fill(SVAR);
  await secretRow.locator('input[type="password"]').fill(SVALUE);
  await expect(panel.locator('.env-var-error')).toHaveCount(0);

  await panel.locator('.project-edit-footer .conn-btn-next').click();
  await expect(panel).not.toBeVisible({ timeout: 3_000 });
}

test('secret env var is injected but stored encrypted (never plaintext on disk)', async ({ shelfApp: { page, userDataDir } }) => {
  await setupProject(page);
  await addProjectSecretVar(page);

  // The Save flush is async → wait for the encrypted side-car to materialize
  // before spawning anything that reads it.
  const secretsFile = path.join(userDataDir, 'project-secrets.json');
  await expect.poll(() => fs.existsSync(secretsFile), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => fs.readFileSync(secretsFile, 'utf8'), { timeout: 5_000 }).toContain('v1:');

  // Encryption at rest: the plaintext value must NOT appear on disk.
  expect(fs.readFileSync(secretsFile, 'utf8')).not.toContain(SVALUE);

  // …yet a newly-spawned terminal receives the decrypted value.
  await page.keyboard.press(`${modifier}+t`);
  await expect(page.locator('.tab-bar .tab')).toHaveCount(2, { timeout: 5_000 });
  const terminal = page.locator('.terminal-container:visible');
  await expect(terminal).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1000);
  await terminal.click();
  await page.keyboard.type(`echo "s=$${SVAR}"`);
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => readActiveTerminalText(page), { timeout: 8_000 })
    .toContain(`s=${SVALUE}`);
});
