import fs from 'node:fs';
import path from 'node:path';
import { test, expect, sendAgentPrompt } from './helpers';

test.use({ copilotUsage: true });

test('Copilot observes usage without rendering context and keeps normal replies', async ({ shelfApp: { page, userDataDir } }) => {
  await page.locator('.sidebar-btn', { hasText: '+' }).click();
  await page.locator('.conn-btn-next').click();
  await expect(page.locator('.fp-browser-path')).toContainText('/');
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`);
  await page.locator('.connect-prompt').click();
  await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
  await page.locator('.tab-add').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Agent (Copilot)' }).click();
  await expect(page.locator('.agent-textarea:visible')).toBeEnabled();

  await sendAgentPrompt(page, 'Observe token usage');
  await expect(page.locator('.agent-msg-reply:visible')).toContainText('Copilot usage observed');
  await expect(page.locator('.agent-status-label:visible')).toHaveText('idle');
  await expect(page.locator('.agent-status-bar:visible')).not.toContainText('ctx:');
  await expect(page.locator('.agent-status-bar:visible')).not.toContainText('premium:');

  // Logs prove both usage fixtures reached the actual provider, so absence in the UI
  // cannot pass just because the test exercised a fake provider or a missing event.
  const readLogs = () => {
    const dir = path.join(userDataDir, 'logs');
    return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith('.log'))
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n') : '';
  };
  await expect.poll(readLogs).toContain('[copilot-usage]');
  const logs = readLogs();
  expect(logs).toContain('invalid_size');
  expect(logs).toContain('"value":1000');
  expect(logs).toContain('session_started');
  expect(logs).toContain('session_settled');
  expect(logs).toContain('prompt_started');
  expect(logs).toContain('prompt_settled');
});
