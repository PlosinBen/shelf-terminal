import { expect, test } from './helpers';
import type { Page } from '@playwright/test';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const memoryValue = /\d+(?:\.\d)? (?:MiB|GiB)/;

test.setTimeout(60_000);

async function setupProject(page: Page): Promise<void> {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await expect(page.locator('.folder-picker-overlay')).toBeVisible({ timeout: 5_000 });
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/', { timeout: 5_000 });
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator('.folder-picker-overlay')).not.toBeVisible({ timeout: 3_000 });

  const prompt = page.locator('.connect-prompt');
  if (await prompt.isVisible({ timeout: 3_000 }).catch(() => false)) await prompt.click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1, { timeout: 5_000 });
}

test('memory rollups stay visible and become numeric after source warm-up', async ({ shelfApp: { page } }) => {
  const footer = page.locator('.bottom-bar-memory');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText('App —');
  await expect(footer).toContainText('Runtime —');
  await expect(footer).toContainText('Agents(0) —');

  await setupProject(page);
  await page.locator('.tab-add').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Agent (Claude)' }).click();

  const agentMemory = page.locator('.agent-status-memory:visible');
  await expect(agentMemory).toBeVisible();
  await expect(agentMemory).toContainText('Memory —');

  await expect(page.locator('.bottom-bar-memory-app')).toContainText(memoryValue, { timeout: 45_000 });
  await expect(page.locator('.bottom-bar-memory-runtime')).toContainText(memoryValue, { timeout: 45_000 });
  await expect(page.locator('.bottom-bar-memory-agents')).toContainText(memoryValue, { timeout: 45_000 });
  await expect(agentMemory).toContainText(memoryValue, { timeout: 45_000 });
});
